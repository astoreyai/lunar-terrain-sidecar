/**
 * Release acceptance for a Godot-consumable terrain package.
 *
 * The terrain is sampled from the checksum-pinned NASA/PGDA Site01 DEM. The
 * production addon builds it, Godot serializes it as a PackedScene, a fresh
 * editor process reloads and raycasts it, then the matching official export
 * template produces a Linux binary and PCK that repeat the same raycast.
 * Elevations are measured; the deterministic rock instances are explicitly
 * modelled, not measured, by the cited Golombek size-frequency distribution.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  elevationAt,
  parseConfig,
  type TerrainDataset,
} from "@lts/shared-types";
import { generateTerrain } from "@lts/terrain-pipeline";
import { exportTerrain } from "@lts/terrain-export";
import { GODOT_BIN as GODOT, SITE01_DEM as DEM } from "./paths.js";

const REPO = resolve(__dirname, "..");
const SHARED_PROJECT = join(REPO, "godot/example-project");
const ADDON_SRC = join(REPO, "godot/addon/lunar_terrain");
const WORK = join(REPO, ".test-artifacts/package");
const PROJECT = join(REPO, ".test-artifacts/package-project");
const DIST = join(WORK, "linux");
const TERRAIN_ID = "package_site01";
const PINNED_GODOT_VERSION = "4.6.3.stable.official.7d41c59c4";
const PINNED_ENGINE_REPORT = "4.6.3-stable (official)";
const PINNED_TEMPLATE_VERSION = "4.6.3.stable";
const SITE01_SHA256 =
  "3ba7b97cb00a2bcf21189c3aeb535f65afc21207154ab9f0d43c5bdc1f7e747e";
const LINUX_RELEASE_TEMPLATE_SHA256 =
  "2c78919325d7f29fa7607287c7c1eeac367ea4c94e7b8b6f5f4c6b20492f73d0";
const EXPECTED_HEIGHT_SHA256 = new Map([
  [
    "context-0",
    "3c978505a123a5f68e91143592afd1c537c58d04052fd7bc6cd1d82516c0a37a",
  ],
  [
    "operational-1",
    "148fad8de2e30faf088549a4a1fea1402efb2a8dc7af63d2b0d02c1d13e5d0b7",
  ],
]);
const EXPECTED_ROCK_COUNT = 186;
const EXPECTED_ROCK_SHA256 =
  "968d6dc68839997f7c714f84e4ba0066c315b9b1f3ecc182fc5c83ba8e8beef3";

const available = existsSync(GODOT) && existsSync(DEM);

interface RuntimeReport {
  ok: boolean;
  mode: string;
  terrain_id: string;
  coordinate_system: {
    handedness: string;
    up_axis: string;
    north_axis: string;
    linear_unit: string;
  };
  collision_shapes: number;
  physical_rocks: number;
  rock_collision_bodies: number;
  physical_collision_shapes: number;
  probe: {
    x: number;
    z: number;
    expected_y: number;
    hit_y: number;
    absolute_error_m: number;
  };
  rock_probe: {
    rock_id: string;
    x: number;
    z: number;
    hit_y: number;
    collision_layer: number;
  };
  godot_version: { string: string };
}

interface BuildReport {
  ok: boolean;
  scene_path: string;
  saved_bytes: number;
  terrain_id: string;
  seed: string;
  coordinate_system: RuntimeReport["coordinate_system"];
  collision_shapes: number;
  physical_rocks: number;
  rock_collision_bodies: number;
  physical_collision_shapes: number;
  godot_version: { string: string };
}

interface RockExport {
  count: number;
  physicalCount: number;
  rocks: Array<{ physical: boolean }>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function templateRoot(): string {
  if (process.env.LTS_GODOT_TEMPLATES) return process.env.LTS_GODOT_TEMPLATES;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
  return join(dataHome, "godot/export_templates", PINNED_TEMPLATE_VERSION);
}

function run(command: string, args: string[], timeout = 300_000): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}:\n${output}`,
      { cause: result.error },
    );
  }
  return output;
}

function makeProject(): void {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(join(PROJECT, "addons"), { recursive: true });
  cpSync(
    join(SHARED_PROJECT, "package_project.godot"),
    join(PROJECT, "project.godot"),
  );
  for (const file of [
    "package_builder.gd",
    "package_runtime.gd",
    "package_runtime.tscn",
    "export_presets.cfg",
  ]) {
    cpSync(join(SHARED_PROJECT, file), join(PROJECT, file));
  }
  cpSync(ADDON_SRC, join(PROJECT, "addons/lunar_terrain"), { recursive: true });
}

function runtimeArgs(
  outPath: string,
  mode: string,
  x: number,
  z: number,
  expectedY: number,
): string[] {
  return [
    "--out",
    outPath,
    "--mode",
    mode,
    "--terrain-id",
    TERRAIN_ID,
    "--x",
    String(x),
    "--z",
    String(z),
    "--expected-y",
    String(expectedY),
  ];
}

describe.skipIf(!available)("Godot saved scene and Linux package", () => {
  let dataset: TerrainDataset;
  let build: BuildReport;
  let reload: RuntimeReport;
  let packaged: RuntimeReport;
  let godotOutput = "";
  let binaryPath = "";
  let pckPath = "";
  let measuredSamples = 0;
  let exportedRocks: RockExport;

  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(DIST, { recursive: true });
    makeProject();

    const godotVersion = run(GODOT, ["--version"]).trim();
    if (godotVersion !== PINNED_GODOT_VERSION) {
      throw new Error(
        `Godot release mismatch: expected ${PINNED_GODOT_VERSION}, got ${godotVersion}`,
      );
    }
    const demHash = sha256(DEM);
    if (demHash !== SITE01_SHA256) {
      throw new Error(
        `Site01 DEM checksum mismatch: expected ${SITE01_SHA256}, got ${demHash}`,
      );
    }

    const releaseTemplate = join(templateRoot(), "linux_release.x86_64");
    const templateVersion = join(templateRoot(), "version.txt");
    if (!existsSync(releaseTemplate) || !existsSync(templateVersion)) {
      throw new Error(
        `Official ${PINNED_TEMPLATE_VERSION} Linux export template is required at ${templateRoot()}`,
      );
    }
    const installedTemplateVersion = readFileSync(
      templateVersion,
      "utf8",
    ).trim();
    if (installedTemplateVersion !== PINNED_TEMPLATE_VERSION) {
      throw new Error(
        `Godot template version mismatch: expected ${PINNED_TEMPLATE_VERSION}, got ${installedTemplateVersion}`,
      );
    }
    const templateHash = sha256(releaseTemplate);
    if (templateHash !== LINUX_RELEASE_TEMPLATE_SHA256) {
      throw new Error(
        `Godot Linux release template checksum mismatch: expected ${LINUX_RELEASE_TEMPLATE_SHA256}, got ${templateHash}`,
      );
    }

    godotOutput += run(
      GODOT,
      [
        "--headless",
        "--path",
        PROJECT,
        "--check-only",
        "--script",
        "package_builder.gd",
      ],
      60_000,
    );
    godotOutput += run(
      GODOT,
      [
        "--headless",
        "--path",
        PROJECT,
        "--check-only",
        "--script",
        "package_runtime.gd",
      ],
      60_000,
    );

    const config = parseConfig({
      terrainId: TERRAIN_ID,
      seed: "package-site01-fixed-seed",
      outputDirectory: WORK,
      site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
      layers: [
        {
          role: "context",
          widthMeters: 120,
          lengthMeters: 120,
          resolutionMeters: 2,
        },
        {
          role: "operational",
          widthMeters: 20,
          lengthMeters: 20,
          resolutionMeters: 0.25,
        },
      ],
      tileSizeSamples: 256,
      dem: {
        enabled: true,
        path: DEM,
        applyToRoles: ["context", "operational"],
        effectiveResolutionMeters: 17.5,
      },
      proceduralStack: [],
      craters: { enabled: false },
      rocks: {
        enabled: true,
        model: "golombek_sfd",
        cumulativeFractionalAreaCovered: 0.05,
        minimumDiameterMeters: 0.15,
        maximumDiameterMeters: 1.5,
        physicalMinimumDiameterMeters: 0.15,
        meanBuriedFraction: 0.35,
        angularity: 0.6,
        craterRimEnhancement: 1,
        maximumSlopeDeg: 35,
      },
      regolith: { enabled: false },
      solar: {
        mode: "ephemeris",
        epochUtc: "2026-08-03T00:00:00Z",
        computeHorizon: false,
      },
    });

    const generated = await generateTerrain(config);
    dataset = generated.dataset;
    exportTerrain(dataset, {
      outputDirectory: WORK,
      tileSizeSamples: config.tileSizeSamples,
      solar: generated.solar,
      notes: generated.notes,
      formats: { exr: false, png16: false, glb: false },
    });
    exportedRocks = JSON.parse(readFileSync(join(WORK, "rocks.json"), "utf8"));

    for (const layer of dataset.layers) {
      const heightPath = join(WORK, "layers", layer.id, "height.rf32");
      const expectedHeightHash = EXPECTED_HEIGHT_SHA256.get(layer.id);
      if (!expectedHeightHash || sha256(heightPath) !== expectedHeightHash) {
        throw new Error(
          `unexpected deterministic height bytes for ${layer.id}`,
        );
      }
      const sourceMask = readFileSync(
        join(WORK, "layers", layer.id, "elevation_source.r8"),
      );
      if (sourceMask.some((value) => value !== 1)) {
        throw new Error(
          `${layer.id} contains elevation samples not marked as measured`,
        );
      }
      measuredSamples += sourceMask.length;
    }

    const operational = dataset.layers.find(
      (layer) => layer.role === "operational",
    );
    if (!operational)
      throw new Error("generated terrain has no operational layer");
    const centreCol = Math.floor(operational.widthSamples / 2);
    const centreRow = Math.floor(operational.heightSamples / 2);
    const x =
      operational.bounds.minX +
      (centreCol + 0.001) * operational.horizontalResolutionMeters;
    const z =
      operational.bounds.minZ +
      (centreRow + 0.001) * operational.horizontalResolutionMeters;
    const expectedY = elevationAt(dataset, x, z);
    if (!Number.isFinite(expectedY))
      throw new Error("probe elevation is not finite");

    const buildPath = join(WORK, "build_result.json");
    godotOutput += run(
      GODOT,
      [
        "--headless",
        "--path",
        PROJECT,
        "--script",
        "package_builder.gd",
        "--",
        "--export-dir",
        WORK,
        "--scene",
        "res://packed_terrain.scn",
        "--out",
        buildPath,
      ],
      300_000,
    );
    build = JSON.parse(readFileSync(buildPath, "utf8"));
    cpSync(
      join(PROJECT, "packed_terrain.scn"),
      join(WORK, "packed_terrain.scn"),
    );

    const reloadPath = join(WORK, "reload_result.json");
    godotOutput += run(
      GODOT,
      [
        "--headless",
        "--path",
        PROJECT,
        "--",
        ...runtimeArgs(reloadPath, "saved_scene_reload", x, z, expectedY),
      ],
      300_000,
    );
    reload = JSON.parse(readFileSync(reloadPath, "utf8"));

    binaryPath = join(DIST, "lunar-terrain-package.x86_64");
    godotOutput += run(
      GODOT,
      [
        "--headless",
        "--path",
        PROJECT,
        "--export-release",
        "Linux Package Acceptance",
        binaryPath,
      ],
      600_000,
    );
    pckPath = join(DIST, "lunar-terrain-package.pck");

    if (!existsSync(binaryPath) || !existsSync(pckPath)) {
      throw new Error(
        `Godot reported export success but binary/PCK are missing: ${binaryPath}, ${pckPath}`,
      );
    }

    const packagedPath = join(WORK, "packaged_result.json");
    godotOutput += run(
      binaryPath,
      [
        "--headless",
        "--",
        ...runtimeArgs(packagedPath, "exported_linux_package", x, z, expectedY),
      ],
      300_000,
    );
    packaged = JSON.parse(readFileSync(packagedPath, "utf8"));
  }, 1_200_000);

  afterAll(() => {
    rmSync(PROJECT, { recursive: true, force: true });
  });

  it("uses the pinned official Godot build and checksum-pinned real Site01 DEM", () => {
    expect(build.godot_version.string).toBe(PINNED_ENGINE_REPORT);
    expect(reload.godot_version.string).toBe(PINNED_ENGINE_REPORT);
    expect(packaged.godot_version.string).toBe(PINNED_ENGINE_REPORT);
    expect(sha256(DEM)).toBe(SITE01_SHA256);
    expect(measuredSamples).toBe(
      dataset.layers.reduce((sum, layer) => sum + layer.heightData.length, 0),
    );
    expect(dataset.provenance.literatureModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "golombek_rock_sfd" }),
      ]),
    );
    expect(sha256(join(WORK, "rocks.json"))).toBe(EXPECTED_ROCK_SHA256);
    expect(exportedRocks.count).toBe(EXPECTED_ROCK_COUNT);
    expect(exportedRocks.physicalCount).toBe(EXPECTED_ROCK_COUNT);
    expect(exportedRocks.physicalCount).toBe(exportedRocks.count);
    expect(exportedRocks.rocks.every((rock) => rock.physical)).toBe(true);
  });

  it("persists the addon-built terrain as a non-empty PackedScene", () => {
    expect(build.ok).toBe(true);
    expect(build.scene_path).toBe("res://packed_terrain.scn");
    expect(build.saved_bytes).toBeGreaterThan(0);
    expect(statSync(join(WORK, "packed_terrain.scn")).size).toBe(
      build.saved_bytes,
    );
    expect(build.terrain_id).toBe(TERRAIN_ID);
    expect(build.collision_shapes).toBeGreaterThan(0);
    expect(build.physical_rocks).toBe(exportedRocks.physicalCount);
    expect(build.physical_rocks).toBeGreaterThan(0);
    expect(build.rock_collision_bodies).toBeGreaterThan(0);
    expect(build.physical_collision_shapes).toBe(build.physical_rocks);
  });

  it("reopens the saved scene in a fresh Godot process and raycasts its collision", () => {
    expect(reload.ok).toBe(true);
    expect(reload.mode).toBe("saved_scene_reload");
    expect(reload.terrain_id).toBe(TERRAIN_ID);
    expect(reload.collision_shapes).toBe(build.collision_shapes);
    expect(reload.physical_rocks).toBe(build.physical_rocks);
    expect(reload.rock_collision_bodies).toBe(build.rock_collision_bodies);
    expect(reload.physical_collision_shapes).toBe(
      build.physical_collision_shapes,
    );
    expect(reload.physical_collision_shapes).toBe(reload.physical_rocks);
    expect(reload.physical_rocks).toBeGreaterThan(0);
    expect(reload.rock_collision_bodies).toBeGreaterThan(0);
    expect(reload.physical_collision_shapes).toBeGreaterThan(0);
    expect(reload.rock_probe.rock_id).not.toBe("");
    expect(reload.rock_probe.collision_layer).toBe(2);
    expect(Number.isFinite(reload.rock_probe.hit_y)).toBe(true);
    expect(reload.probe.absolute_error_m).toBeLessThan(0.002);
  });

  it("exports a standalone Linux binary and PCK with the official release template", () => {
    expect(statSync(binaryPath).size).toBeGreaterThan(50_000_000);
    expect(sha256(binaryPath)).toBe(LINUX_RELEASE_TEMPLATE_SHA256);
    expect(statSync(pckPath).size).toBeGreaterThan(0);
  });

  it("launches the exported package and preserves terrain metadata and collision", () => {
    expect(packaged.ok).toBe(true);
    expect(packaged.mode).toBe("exported_linux_package");
    expect(packaged.terrain_id).toBe(TERRAIN_ID);
    expect(packaged.coordinate_system).toEqual(reload.coordinate_system);
    expect(packaged.collision_shapes).toBe(reload.collision_shapes);
    expect(packaged.physical_rocks).toBe(reload.physical_rocks);
    expect(packaged.rock_collision_bodies).toBe(reload.rock_collision_bodies);
    expect(packaged.physical_collision_shapes).toBe(
      reload.physical_collision_shapes,
    );
    expect(packaged.physical_rocks).toBeGreaterThan(0);
    expect(packaged.rock_collision_bodies).toBeGreaterThan(0);
    expect(packaged.physical_collision_shapes).toBeGreaterThan(0);
    expect(packaged.rock_probe).toEqual(reload.rock_probe);
    expect(packaged.probe.absolute_error_m).toBeLessThan(0.002);
    expect(packaged.probe.hit_y).toBeCloseTo(reload.probe.hit_y, 6);
  });

  it("completes without GDScript parse or runtime errors", () => {
    expect(godotOutput).not.toMatch(/Parse Error|SCRIPT ERROR|ERROR:/);
  });
});
