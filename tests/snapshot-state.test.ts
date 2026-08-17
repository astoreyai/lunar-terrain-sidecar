/**
 * Complete snapshot state over the real PGDA/LOLA Site01 DEM.
 *
 * This suite proves that terrain.snapshot / restoreSnapshot moves one coherent
 * world state: every raster mask, construction records, rock transforms, the
 * operation audit log, retained deltas and their sequence head. It also
 * rewrites a corrupt state file's checksum to prove schema validation—not
 * checksum checking alone—protects the live dataset atomically.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { WebSocketServer } from "ws";
import { startServer } from "../apps/headless-server/src/server.js";
import { validateDataset } from "@lts/terrain-validation";
import { DELTA_WINDOW } from "@lts/terrain-protocol";
import { SITE01_DEM } from "./paths.js";

const PORT = 8818;
// The shipped demonstration site's crater model, so generated craters carry
// the real production_csfd provenance and per-layer id scheme.
const PRODUCTION_CSFD_CRATERS = {
  enabled: true,
  model: "production_csfd",
  minimumDiameterMeters: 0.2,
  maximumDiameterMeters: 35,
  surfaceAgeGyr: 3.5,
  meanDegradation: 0.45,
  degradationSpread: 0.3,
  ellipticalFraction: 0.15,
  clustering: 0,
};
const WORK = resolve(__dirname, "../.test-artifacts/snapshot-state");
const available = existsSync(SITE01_DEM);

describe("complete snapshot state on the real Site01 DEM", () => {
  let server: WebSocketServer;
  let socket: WebSocket;
  let nextId = 1;

  function rpcOn(
    client: WebSocket,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<any> {
    const id = nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout on ${method}`)),
        120_000,
      );
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString());
        if (message.id !== id) return;
        clearTimeout(timer);
        client.off("message", onMessage);
        resolvePromise(message);
      };
      client.on("message", onMessage);
      client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    return rpcOn(socket, method, params);
  }

  async function generate(
    options: {
      outputDirectory?: string;
      site?: { latitudeDeg: number; longitudeDeg: number };
      tileSizeSamples?: number;
      bulkDensityKgM3?: number;
      terrainId?: string;
      seed?: string;
      layers?: Array<{
        role: string;
        widthMeters: number;
        lengthMeters: number;
        resolutionMeters: number;
      }>;
      craters?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const started = await rpc("terrain.generate", {
      config: {
        schemaVersion: "1.0.0",
        terrainId: options.terrainId ?? "snapshot_site01",
        seed: options.seed ?? "snapshot-site01-fixed",
        outputDirectory: options.outputDirectory ?? join(WORK, "generated"),
        site: options.site ?? {
          latitudeDeg: -89.4631639,
          longitudeDeg: -137.4895528,
        },
        layers: options.layers ?? [
          {
            role: "context",
            widthMeters: 80,
            lengthMeters: 80,
            resolutionMeters: 1,
          },
        ],
        tileSizeSamples: options.tileSizeSamples ?? 64,
        bulkDensityKgM3: options.bulkDensityKgM3 ?? 1500,
        dem: {
          enabled: true,
          path: SITE01_DEM,
          applyToRoles: (options.layers ?? [{ role: "context" }]).map(
            (layer) => layer.role,
          ),
          effectiveResolutionMeters: 17.5,
        },
        proceduralStack: [],
        craters: options.craters ?? { enabled: false },
        rocks: {
          enabled: true,
          model: "golombek_sfd",
          cumulativeFractionalAreaCovered: 0.05,
          minimumDiameterMeters: 0.1,
          maximumDiameterMeters: 1.2,
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
      },
    });
    expect(started.result?.jobId).toBeDefined();
    for (let i = 0; i < 600; i++) {
      await new Promise((done) => setTimeout(done, 100));
      const status = (
        await rpc("terrain.getStatus", { jobId: started.result.jobId })
      ).result;
      if (status.status === "complete") return;
      if (status.status === "failed" || status.status === "cancelled") {
        throw new Error(
          `Site01 generation ended ${status.status}: ${JSON.stringify(status.error)}`,
        );
      }
    }
    throw new Error("Site01 generation timed out");
  }

  beforeAll(async () => {
    if (!available) {
      throw new Error(
        `required real Site01 DEM is unavailable at ${SITE01_DEM}; fetch and verify the public PGDA product before running snapshot acceptance`,
      );
    }
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    await generate();
  }, 120_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("streams stride-1 semantic tiles with a constrained channel contract", async () => {
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[0];
    const defaultChannel = await rpc("terrain.getTile", {
      layerId: layer.id,
      col0: 0,
      row0: 0,
      width: 1,
      height: 1,
    });
    expect(defaultChannel.result).toMatchObject({
      channel: "height",
      encoding: "base64:float32le",
      stride: 1,
    });
    const response = await rpc("terrain.getTile", {
      layerId: layer.id,
      channel: "semantic",
      col0: 3,
      row0: 4,
      width: 5,
      height: 4,
      stride: 1,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      layerId: layer.id,
      channel: "semantic",
      col0: 3,
      row0: 4,
      width: 5,
      height: 4,
      stride: 1,
      encoding: "base64:uint8",
    });
    const values = Buffer.from(response.result.data, "base64");
    expect(values.byteLength).toBe(5 * 4);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        const x = layer.bounds.minX + (3 + col) * layer.resolutionMeters;
        const z = layer.bounds.minZ + (4 + row) * layer.resolutionMeters;
        const point = (await rpc("terrain.getSemanticClass", { x, z })).result;
        expect(values[row * 5 + col]).toBe(point.index);
      }
    }

    const unknown = await rpc("terrain.getTile", {
      layerId: layer.id,
      channel: "albedo",
      col0: 0,
      row0: 0,
      width: 1,
      height: 1,
    });
    expect(unknown.error.data.code).toBe("TERRAIN_INVALID_CONFIG");
    expect(unknown.error.message).toMatch(/channel/);

    const decimated = await rpc("terrain.getTile", {
      layerId: layer.id,
      channel: "semantic",
      col0: 0,
      row0: 0,
      width: 2,
      height: 2,
      stride: 2,
    });
    expect(decimated.error.data.code).toBe("TERRAIN_INVALID_CONFIG");
    expect(decimated.error.message).toMatch(/stride 1/);
  });

  it("restores terrain, masks, features, rocks and audit state atomically", async () => {
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[0];
    expect(layer.elevationProvenance).toBe("measured_dem");

    const initialRocks = (
      await rpc("terrain.getRocks", { maxInstances: 50_000 })
    ).result;
    expect(initialRocks.truncated).toBe(false);
    expect(initialRocks.rocks.length).toBeGreaterThan(0);
    const rock = initialRocks.rocks.find((candidate: any) => {
      const [x, , z] = candidate.position_m;
      return (
        x > layer.bounds.minX + 5 &&
        x < layer.bounds.maxX - 5 &&
        z > layer.bounds.minZ + 5 &&
        z < layer.bounds.maxZ - 5
      );
    });
    expect(rock).toBeDefined();
    const [rockX, initialRockY, rockZ] = rock.position_m;
    const ground = (await rpc("terrain.getHeight", { x: rockX, z: rockZ }))
      .result.elevationM;
    const polygon = [
      [rockX - 2, rockZ - 2],
      [rockX + 2, rockZ - 2],
      [rockX + 2, rockZ + 2],
      [rockX - 2, rockZ + 2],
    ];

    const firstCut = await rpc("terrain.applyOperation", {
      operation: {
        kind: "polygonal_cut",
        layerId: layer.id,
        centerXMeters: rockX,
        centerZMeters: rockZ,
        radiusMeters: 1,
        strengthMeters: 0.5,
        targetElevationMeters: ground - 0.5,
        polygonXZ: polygon,
      },
    });
    expect(firstCut.error).toBeUndefined();
    expect(firstCut.result.rocksReseated).toBe(40);
    expect(firstCut.result.delta.rocksReseated).toBe(
      firstCut.result.rocksReseated,
    );
    const fetchedFirstCut = await rpc("terrain.getDelta", {
      datasetRevision: dataset.datasetRevision,
      sequenceNumber: firstCut.result.delta.sequenceNumber,
    });
    expect(fetchedFirstCut.result.rocksReseated).toBe(
      firstCut.result.rocksReseated,
    );
    const firstCutPoll = (
      await rpc("terrain.getChangedSince", {
        datasetRevision: dataset.datasetRevision,
        sequenceNumber: firstCut.result.delta.sequenceNumber,
      })
    ).result;
    expect(firstCutPoll.rocksReseated).toBe(firstCut.result.rocksReseated);

    const snapshotRocks = (
      await rpc("terrain.getRocks", { maxInstances: 50_000 })
    ).result;
    const snapshotRock = snapshotRocks.rocks.find(
      (candidate: any) => candidate.id === rock.id,
    );
    expect(snapshotRock.position_m[1]).toBeLessThan(initialRockY);
    expect(
      (await rpc("terrain.getSemanticClass", { x: rockX, z: rockZ })).result
        .semanticClass,
    ).toBe("trench");
    const snapshotLog = (await rpc("terrain.getOperationLog")).result;
    expect(snapshotLog.operations).toHaveLength(1);
    expect(snapshotLog.deltas).toHaveLength(1);
    expect(snapshotLog.deltas[0].rocksReseated).toBe(
      firstCut.result.rocksReseated,
    );

    const beforeExport = join(WORK, "before-restore-export");
    const beforeExportResult = await rpc("terrain.export", {
      outputDirectory: beforeExport,
      formats: { exr: false, png16: false, npy: false, glb: false },
    });
    expect(beforeExportResult.result.artifacts).toBeGreaterThan(0);
    const validationBeforeRestore = beforeExportResult.result.validation;
    const realDataValidation = validateDataset(beforeExport);
    const floating = realDataValidation.checks.find(
      (check) => check.id === "rocks_not_floating",
    );
    expect(floating?.measured).toMatchObject({ total: 6596 });
    expect(floating?.measured?.floating).toBe(0);
    expect(realDataValidation.passed).toBe(true);
    const rocksBefore = readFileSync(join(beforeExport, "rocks.json"));
    const constructionBefore = readFileSync(
      join(beforeExport, "features_construction.json"),
    );

    const snapshot = (await rpc("terrain.snapshot")).result;
    expect(snapshot).toMatchObject({ snapshotVersion: 2, sequenceNumber: 1 });
    expect(snapshot.layers).toHaveLength(1);
    expect(snapshot.layers[0].masks.semantic).toMatchObject({
      encoding: "uint8",
    });
    // The real generated layer carries no disturbance raster; absence itself
    // is part of the exact snapshot state and must not be replaced by zeros.
    expect(snapshot.layers[0].masks.disturbance).toBeNull();
    expect(snapshot.layers[0].masks.elevationSource).toMatchObject({
      encoding: "uint8",
    });
    for (const mask of (
      Object.values(snapshot.layers[0].masks) as any[]
    ).filter(Boolean)) {
      expect(mask.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(mask.bytes).toBeGreaterThan(0);
    }

    const statePath = join(snapshot.directory, snapshot.stateFile);
    const originalStateBytes = readFileSync(statePath);
    const originalManifestBytes = readFileSync(
      join(snapshot.directory, "snapshot.json"),
    );
    const savedState = JSON.parse(originalStateBytes.toString("utf8"));
    expect(savedState.nextSequence).toBe(1);
    expect(savedState.operationLog).toEqual(snapshotLog.operations);
    expect(savedState.deltas).toHaveLength(1);
    expect(savedState.deltas[0].rocksReseated).toBe(
      firstCut.result.rocksReseated,
    );
    expect(
      savedState.featureManifest.some((feature: any) => feature.id === rock.id),
    ).toBe(true);
    expect(
      savedState.featureManifest.some(
        (feature: any) => feature.id === "construction-op-000000",
      ),
    ).toBe(true);

    const secondCut = await rpc("terrain.applyOperation", {
      operation: {
        kind: "polygonal_cut",
        layerId: layer.id,
        centerXMeters: rockX,
        centerZMeters: rockZ,
        radiusMeters: 1,
        strengthMeters: 0.5,
        targetElevationMeters: ground - 1,
        polygonXZ: polygon,
      },
    });
    expect(secondCut.result.delta.sequenceNumber).toBe(1);
    const afterCutRocks = (
      await rpc("terrain.getRocks", { maxInstances: 50_000 })
    ).result;
    expect(
      afterCutRocks.rocks.find((candidate: any) => candidate.id === rock.id)
        .position_m[1],
    ).toBeLessThan(snapshotRock.position_m[1]);
    expect(
      (await rpc("terrain.getOperationLog")).result.operations,
    ).toHaveLength(2);

    const restored = (
      await rpc("terrain.restoreSnapshot", { directory: snapshot.directory })
    ).result;
    expect(restored).toMatchObject({
      snapshotSequenceNumber: 1,
      restoredLayers: 1,
      restoredOperations: 1,
      nextSequence: 1,
    });
    expect(restored.restoredFeatures).toBe(savedState.featureManifest.length);
    expect(
      (await rpc("terrain.getRocks", { maxInstances: 50_000 })).result,
    ).toEqual({ ...snapshotRocks, datasetRevision: restored.datasetRevision });
    expect((await rpc("terrain.getOperationLog")).result).toEqual(snapshotLog);
    expect(
      (await rpc("terrain.getSemanticClass", { x: rockX, z: rockZ })).result
        .semanticClass,
    ).toBe("trench");

    const afterExport = join(WORK, "after-restore-export");
    const afterExportResult = await rpc("terrain.export", {
      outputDirectory: afterExport,
      formats: { exr: false, png16: false, npy: false, glb: false },
    });
    expect(afterExportResult.result.validation).toEqual(
      validationBeforeRestore,
    );
    expect(readFileSync(join(afterExport, "rocks.json"))).toEqual(rocksBefore);
    expect(
      readFileSync(join(afterExport, "features_construction.json")),
    ).toEqual(constructionBefore);

    // Move the live world away from the snapshot, then corrupt the saved
    // elevation-source raster. Restore must reject it without rolling back any
    // height, rock, feature or history component.
    const branch = await rpc("terrain.applyOperation", {
      operation: {
        kind: "lower",
        layerId: layer.id,
        centerXMeters: rockX,
        centerZMeters: rockZ,
        radiusMeters: 2,
        strengthMeters: 0.2,
      },
    });
    expect(branch.result.delta.sequenceNumber).toBe(1);
    expect(branch.result.operation.operationId).toBe("op-000001");
    const liveHeight = (await rpc("terrain.getHeight", { x: rockX, z: rockZ }))
      .result.elevationM;
    const liveRocks = (await rpc("terrain.getRocks", { maxInstances: 50_000 }))
      .result;
    const liveLog = (await rpc("terrain.getOperationLog")).result;

    const elevationSourcePath = join(
      snapshot.directory,
      snapshot.layers[0].masks.elevationSource.file,
    );
    const elevationSourceBytes = readFileSync(elevationSourcePath);
    const corruptElevationSource = Buffer.from(elevationSourceBytes);
    corruptElevationSource[Math.floor(corruptElevationSource.length / 2)] ^=
      0xff;
    writeFileSync(elevationSourcePath, corruptElevationSource);
    const corruptMaskRestore = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(corruptMaskRestore.error.data.code).toBe(
      "TERRAIN_VALIDATION_FAILED",
    );
    expect(corruptMaskRestore.error.data.details.mismatches).toContainEqual(
      expect.objectContaining({
        file: snapshot.layers[0].masks.elevationSource.file,
        problem: "checksum mismatch",
      }),
    );
    expect(
      (await rpc("terrain.getHeight", { x: rockX, z: rockZ })).result
        .elevationM,
    ).toBe(liveHeight);
    expect(
      (await rpc("terrain.getRocks", { maxInstances: 50_000 })).result,
    ).toEqual(liveRocks);
    expect((await rpc("terrain.getOperationLog")).result).toEqual(liveLog);
    writeFileSync(elevationSourcePath, elevationSourceBytes);

    // A caller able to rewrite the checksum still cannot smuggle malformed
    // delta or feature state into the live dataset: structural validation is
    // staged, and the exact reseat count is a non-negative integer consistent
    // with whether the rock-transfer digest changed.
    const malformedCases: Array<(state: any) => void> = [
      (state) => {
        state.deltas[0].rocksReseated = -1;
      },
      (state) => {
        state.deltas[0].rocksReseated = 0.5;
      },
      (state) => {
        state.deltas[0].rocksReseated = 0;
      },
      (state) => {
        const savedRock = state.featureManifest.find(
          (feature: any) => feature.id === rock.id,
        );
        savedRock.position.x = null;
      },
    ];
    for (const mutate of malformedCases) {
      const malformedState = JSON.parse(originalStateBytes.toString("utf8"));
      mutate(malformedState);
      const malformedStateBytes = Buffer.from(
        JSON.stringify(malformedState, null, 2),
      );
      writeFileSync(statePath, malformedStateBytes);
      const malformedManifest = JSON.parse(
        originalManifestBytes.toString("utf8"),
      );
      malformedManifest.stateSha256 = createHash("sha256")
        .update(malformedStateBytes)
        .digest("hex");
      malformedManifest.stateBytes = malformedStateBytes.byteLength;
      writeFileSync(
        join(snapshot.directory, "snapshot.json"),
        JSON.stringify(malformedManifest, null, 2),
      );

      const malformedRestore = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
      expect(malformedRestore.error.data.code).toBe(
        "TERRAIN_VALIDATION_FAILED",
      );
      expect(malformedRestore.error.data.details.mismatches).toContainEqual(
        expect.objectContaining({
          file: snapshot.stateFile,
          problem: "malformed state",
        }),
      );
      expect(
        (await rpc("terrain.getHeight", { x: rockX, z: rockZ })).result
          .elevationM,
      ).toBe(liveHeight);
      expect(
        (await rpc("terrain.getRocks", { maxInstances: 50_000 })).result,
      ).toEqual(liveRocks);
      expect((await rpc("terrain.getOperationLog")).result).toEqual(liveLog);
    }

    // A syntactically valid, re-hashed state must also bind the terminal rock
    // transfer to the restored real feature manifest. Reusing the real digest
    // from the later live branch keeps this positive-reseat mutation
    // well-formed while making it semantically false for the saved state.
    const falseTerminalState = JSON.parse(originalStateBytes.toString("utf8"));
    expect(falseTerminalState.deltas[0].rocksReseated).toBeGreaterThan(0);
    expect(falseTerminalState.deltas[0].previousRockTransferSha256).not.toBe(
      falseTerminalState.deltas[0].resultingRockTransferSha256,
    );
    expect(liveRocks.transferSha256).not.toBe(
      falseTerminalState.deltas[0].previousRockTransferSha256,
    );
    expect(liveRocks.transferSha256).not.toBe(
      falseTerminalState.deltas[0].resultingRockTransferSha256,
    );
    falseTerminalState.deltas[0].resultingRockTransferSha256 =
      liveRocks.transferSha256;
    const falseTerminalBytes = Buffer.from(
      JSON.stringify(falseTerminalState, null, 2),
    );
    writeFileSync(statePath, falseTerminalBytes);
    const falseTerminalManifest = JSON.parse(
      originalManifestBytes.toString("utf8"),
    );
    falseTerminalManifest.stateSha256 = createHash("sha256")
      .update(falseTerminalBytes)
      .digest("hex");
    falseTerminalManifest.stateBytes = falseTerminalBytes.byteLength;
    writeFileSync(
      join(snapshot.directory, "snapshot.json"),
      JSON.stringify(falseTerminalManifest, null, 2),
    );
    const falseTerminalRestore = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(falseTerminalRestore.error.data.code).toBe(
      "TERRAIN_VALIDATION_FAILED",
    );
    expect(falseTerminalRestore.error.data.details.mismatches).toContainEqual(
      expect.objectContaining({
        file: snapshot.stateFile,
        problem: "terminal rock transfer checksum does not match restored features",
      }),
    );
    expect(
      (await rpc("terrain.getRocks", { maxInstances: 50_000 })).result,
    ).toEqual(liveRocks);
    expect((await rpc("terrain.getOperationLog")).result).toEqual(liveLog);
  }, 120_000);

  it("rejects a same-name snapshot from a different real site/configuration", async () => {
    const outputDirectory = join(WORK, "identity-binding");
    await generate({
      outputDirectory,
      tileSizeSamples: 64,
      bulkDensityKgM3: 1500,
    });
    const snapshot = (await rpc("terrain.snapshot")).result;

    // Same id, seed, real source and grid dimensions, but a distinct site and
    // session configuration. A terrainId+seed-only check previously accepted
    // this and combined the snapshot heights with the CURRENT metadata.
    await generate({
      outputDirectory,
      site: { latitudeDeg: -89.4629, longitudeDeg: -137.48 },
      tileSizeSamples: 32,
      bulkDensityKgM3: 1700,
    });
    const currentBefore = (await rpc("terrain.getDataset")).result;
    const restored = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(restored.error.data.code).toBe("TERRAIN_INVALID_CONFIG");
    expect(restored.error.message).toMatch(/identity|configuration|metadata/i);
    expect((await rpc("terrain.getDataset")).result).toEqual(currentBefore);
  }, 120_000);

  it("rejects re-hashed semantic sparse state with an invalid class value", async () => {
    await generate({
      outputDirectory: join(WORK, "semantic-state-validation"),
    });
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[0];
    const painted = await rpc("terrain.applyOperation", {
      operation: {
        kind: "semantic_paint",
        layerId: layer.id,
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 2,
        strengthMeters: 0,
        semanticClass: "trench",
      },
    });
    expect(painted.error).toBeUndefined();
    expect(painted.result.delta.changedMaskSampleCount).toBeGreaterThan(0);
    expect(painted.result.rocksReseated).toBe(0);
    expect(painted.result.delta.rocksReseated).toBe(0);
    const fetched = await rpc("terrain.getDelta", {
      datasetRevision: dataset.datasetRevision,
      sequenceNumber: painted.result.delta.sequenceNumber,
    });
    expect(fetched.result.rocksReseated).toBe(0);
    const poll = (
      await rpc("terrain.getChangedSince", {
        datasetRevision: dataset.datasetRevision,
        sequenceNumber: painted.result.delta.sequenceNumber,
      })
    ).result;
    expect(poll.rocksReseated).toBe(0);

    const snapshot = (await rpc("terrain.snapshot")).result;
    const statePath = join(snapshot.directory, snapshot.stateFile);
    const manifestPath = join(snapshot.directory, "snapshot.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.deltas[0].rocksReseated).toBe(0);
    expect(state.deltas[0].previousRockTransferSha256).toBe(
      state.deltas[0].resultingRockTransferSha256,
    );
    const restoredSnapshot = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(restoredSnapshot.error).toBeUndefined();
    expect(
      (await rpc("terrain.getOperationLog")).result.deltas[0].rocksReseated,
    ).toBe(0);
    const values = Buffer.from(state.deltas[0].maskSparse.values, "base64");
    expect(values.byteLength).toBe(state.deltas[0].changedMaskSampleCount);
    values[0] = 255;
    state.deltas[0].maskSparse.values = values.toString("base64");
    const stateBytes = Buffer.from(JSON.stringify(state, null, 2));
    writeFileSync(statePath, stateBytes);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.stateSha256 = createHash("sha256")
      .update(stateBytes)
      .digest("hex");
    manifest.stateBytes = stateBytes.byteLength;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const before = (await rpc("terrain.getOperationLog")).result;
    const restored = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(restored.error.data.code).toBe("TERRAIN_VALIDATION_FAILED");
    expect(restored.error.data.details.mismatches).toContainEqual(
      expect.objectContaining({
        file: snapshot.stateFile,
        problem: "malformed state",
      }),
    );
    expect((await rpc("terrain.getOperationLog")).result).toEqual(before);
  }, 120_000);

  it("rejects snapshot mask-channel omission and injection atomically", async () => {
    const corruptions: Array<{
      name: string;
      mutate: (manifest: any, directory: string) => void;
    }> = [
      {
        name: "required semantic channel omitted",
        mutate: (manifest) => {
          manifest.layers[0].masks.semantic = null;
          manifest.layers[0].maskFile = null;
          manifest.layers[0].maskSha256 = createHash("sha256")
            .update(Buffer.alloc(0))
            .digest("hex");
        },
      },
      {
        name: "required elevation-source channel omitted",
        mutate: (manifest) =>
          (manifest.layers[0].masks.elevationSource = null),
      },
      {
        name: "undeclared disturbance channel injected",
        mutate: (manifest) => {
          const layer = manifest.layers[0];
          // Reuse the snapshot's real production-generated float32 height
          // artifact. Presence validation must reject this descriptor before
          // any channel bytes are read or interpreted as disturbance data.
          manifest.layers[0].masks.disturbance = {
            file: layer.heightFile,
            sha256: layer.heightSha256,
            bytes: layer.heightBytes,
            encoding: "float32le",
          };
        },
      },
    ];

    for (let i = 0; i < corruptions.length; i++) {
      const corruption = corruptions[i];
      await generate({
        outputDirectory: join(WORK, `mask-presence-validation-${i}`),
      });
      const dataset = (await rpc("terrain.getDataset")).result;
      const snapshot = (await rpc("terrain.snapshot")).result;
      await rpc("terrain.applyOperation", {
        operation: {
          kind: "raise",
          layerId: dataset.layers[0].id,
          centerXMeters: 20,
          centerZMeters: -20,
          radiusMeters: 1.1,
          strengthMeters: 0.01,
        },
      });
      const liveBefore = {
        dataset: (await rpc("terrain.getDataset")).result,
        audit: (await rpc("terrain.getOperationLog")).result,
      };

      const manifestPath = join(snapshot.directory, "snapshot.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      corruption.mutate(manifest, snapshot.directory);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const restored = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
      expect.soft(restored.error?.data?.code, corruption.name).toBe(
        "TERRAIN_VALIDATION_FAILED",
      );
      expect.soft(
        restored.error?.data?.details?.mismatches,
        `${corruption.name} did not fail at the schema-presence boundary`,
      ).toContainEqual(
        expect.objectContaining({
          layerId: dataset.layers[0].id,
          problem: "mask channel presence mismatch",
        }),
      );
      if (restored.error) {
        expect.soft(
          {
            dataset: (await rpc("terrain.getDataset")).result,
            audit: (await rpc("terrain.getOperationLog")).result,
          },
          `${corruption.name} changes live state`,
        ).toEqual(liveBefore);
      }
    }
  }, 120_000);

  it("rejects malformed live operation input without changing terrain or history", async () => {
    await generate({ outputDirectory: join(WORK, "live-operation-validation") });
    const dataset = (await rpc("terrain.getDataset")).result;
    const layerId = dataset.layers[0].id;
    const base = {
      layerId,
      centerXMeters: 0,
      centerZMeters: 0,
      radiusMeters: 2,
      strengthMeters: 0.2,
    };
    const invalidOperations: Array<{ name: string; operation: any }> = [
      {
        name: "non-boolean massConserving",
        operation: { kind: "raise", ...base, massConserving: "false" },
      },
      {
        name: "flatten without target elevation",
        operation: { kind: "flatten", ...base },
      },
      {
        name: "rectangular pad without heading",
        operation: {
          kind: "pad",
          ...base,
          targetElevationMeters: 0,
          lengthMeters: 10,
        },
      },
      {
        name: "trench without heading",
        operation: { kind: "trench", ...base, lengthMeters: 10 },
      },
      {
        name: "trench without length",
        operation: { kind: "trench", ...base, headingDegrees: 25 },
      },
      {
        name: "berm without heading",
        operation: { kind: "berm", ...base, lengthMeters: 10 },
      },
      {
        name: "berm with non-positive length",
        operation: {
          kind: "berm",
          ...base,
          headingDegrees: 25,
          lengthMeters: 0,
        },
      },
    ];

    for (const candidate of invalidOperations) {
      const before = {
        dataset: (await rpc("terrain.getDataset")).result,
        audit: (await rpc("terrain.getOperationLog")).result,
      };
      const response = await rpc("terrain.applyOperation", {
        operation: candidate.operation,
      });
      expect.soft(response.error?.data?.code, candidate.name).toBe(
        "TERRAIN_INVALID_CONFIG",
      );
      expect.soft(
        {
          dataset: (await rpc("terrain.getDataset")).result,
          audit: (await rpc("terrain.getOperationLog")).result,
        },
        `${candidate.name} changed live state`,
      ).toEqual(before);
    }
  }, 120_000);

  it("rejects re-hashed construction state outside its operation and physical domains", async () => {
    await generate({ outputDirectory: join(WORK, "construction-state-validation") });
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[0];
    const applied = await rpc("terrain.applyOperation", {
      operation: {
        kind: "trench",
        layerId: layer.id,
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 2,
        strengthMeters: 0.3,
        headingDegrees: 37,
        lengthMeters: 12,
        massConserving: true,
      },
    });
    expect(applied.error).toBeUndefined();
    const snapshot = (await rpc("terrain.snapshot")).result;
    const statePath = join(snapshot.directory, snapshot.stateFile);
    const manifestPath = join(snapshot.directory, "snapshot.json");
    const originalState = JSON.parse(readFileSync(statePath, "utf8"));
    const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const construction = originalState.featureManifest.find(
      (feature: any) => feature.id === "construction-op-000000",
    );
    expect(construction).toBeDefined();
    expect(construction.kind).toBe("trench");

    const corruptions: Array<{
      name: string;
      mutate: (state: any, feature: any) => void;
    }> = [
      {
        name: "empty applied layer set",
        mutate: (_state, feature) => (feature.appliedToLayers = []),
      },
      {
        name: "negative removed volume",
        mutate: (_state, feature) => (feature.massBalance.removedVolumeM3 = -1),
      },
      {
        name: "mass balance arithmetic does not close",
        mutate: (_state, feature) => {
          feature.massBalance.netVolumeM3 += 0.125;
          feature.massBalance.netMassKg =
            feature.massBalance.netVolumeM3 * feature.massBalance.bulkDensityKgM3;
        },
      },
      {
        name: "unordered elevation statistics",
        mutate: (_state, feature) =>
          (feature.elevationBefore.mean = feature.elevationBefore.max + 1),
      },
      {
        name: "unknown construction semantic class",
        mutate: (_state, feature) =>
          (feature.semanticClass = "unregistered_surface_class"),
      },
      {
        name: "feature parameters diverge from their operation",
        mutate: (_state, feature) => (feature.parameters.headingDegrees += 1),
      },
      {
        name: "trench operation omits length",
        mutate: (state, feature) => {
          delete state.operationLog[0].lengthMeters;
          delete state.deltas[0].operations[0].lengthMeters;
          delete feature.parameters.lengthMeters;
        },
      },
      {
        name: "trench operation omits heading",
        mutate: (state, feature) => {
          delete state.operationLog[0].headingDegrees;
          delete state.deltas[0].operations[0].headingDegrees;
          delete feature.parameters.headingDegrees;
        },
      },
      {
        name: "trench operation has non-positive length",
        mutate: (state, feature) => {
          state.operationLog[0].lengthMeters = 0;
          state.deltas[0].operations[0].lengthMeters = 0;
          feature.parameters.lengthMeters = 0;
        },
      },
    ];

    for (let i = 0; i < corruptions.length; i++) {
      const corruption = corruptions[i];
      await rpc("terrain.applyOperation", {
        operation: {
          kind: i % 2 === 0 ? "raise" : "lower",
          layerId: layer.id,
          centerXMeters: 24,
          centerZMeters: -24,
          radiusMeters: 1.1,
          strengthMeters: 0.01,
        },
      });
      const liveBefore = {
        dataset: (await rpc("terrain.getDataset")).result,
        audit: (await rpc("terrain.getOperationLog")).result,
      };

      const state = structuredClone(originalState);
      const feature = state.featureManifest.find(
        (candidate: any) => candidate.id === construction.id,
      );
      corruption.mutate(state, feature);
      const stateBytes = Buffer.from(JSON.stringify(state, null, 2));
      writeFileSync(statePath, stateBytes);
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            ...originalManifest,
            stateSha256: createHash("sha256").update(stateBytes).digest("hex"),
            stateBytes: stateBytes.byteLength,
          },
          null,
          2,
        ),
      );

      const restored = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
      expect.soft(restored.error?.data?.code, corruption.name).toBe(
        "TERRAIN_VALIDATION_FAILED",
      );
      if (restored.error) {
        expect.soft(
          {
            dataset: (await rpc("terrain.getDataset")).result,
            audit: (await rpc("terrain.getOperationLog")).result,
          },
          `${corruption.name} changes live state`,
        ).toEqual(liveBefore);
      }
    }
  }, 120_000);

  it("rejects independently invalid crater domains from a re-hashed snapshot", async () => {
    // Generate real production-CSFD craters on the Site01 crop and use one of
    // them, provenance-labelled by the generator itself, as the template rather
    // than inventing test geometry or reading a machine-local export. The
    // adversarial mutation below changes exactly one scientific domain at a time.
    await generate({
      outputDirectory: join(WORK, "crater-state-validation"),
      craters: PRODUCTION_CSFD_CRATERS,
    });
    const snapshot = (await rpc("terrain.snapshot")).result;
    const statePath = join(snapshot.directory, snapshot.stateFile);
    const manifestPath = join(snapshot.directory, "snapshot.json");
    const originalState = JSON.parse(readFileSync(statePath, "utf8"));
    const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const crater = originalState.featureManifest.find(
      (feature: any) => feature.kind === "crater",
    );
    expect(crater).toBeDefined();
    expect(crater.origin).toBe("production_csfd");

    const corruptions: Array<{
      name: string;
      mutate: (candidate: any) => void;
    }> = [
      {
        name: "negative crater diameter",
        mutate: (candidate) => (candidate.parameters.diameterMeters = -1),
      },
      {
        name: "negative crater depth",
        mutate: (candidate) => (candidate.parameters.depthMeters = -1),
      },
      {
        name: "negative rim width",
        mutate: (candidate) => (candidate.parameters.rimWidthMeters = -1),
      },
      {
        name: "floor radius ratio below zero",
        mutate: (candidate) => (candidate.parameters.floorRadiusRatio = -0.01),
      },
      {
        name: "floor radius ratio above one",
        mutate: (candidate) => (candidate.parameters.floorRadiusRatio = 1.01),
      },
      {
        name: "ellipticity below zero",
        mutate: (candidate) => (candidate.parameters.ellipticity = -0.01),
      },
      {
        name: "ellipticity above one",
        mutate: (candidate) => (candidate.parameters.ellipticity = 1.01),
      },
      {
        name: "degradation below zero",
        mutate: (candidate) => (candidate.parameters.degradation = -0.01),
      },
      {
        name: "degradation above one",
        mutate: (candidate) => (candidate.parameters.degradation = 1.01),
      },
    ];

    for (let i = 0; i < corruptions.length; i++) {
      const corruption = corruptions[i];
      const state = structuredClone(originalState);
      const candidate = structuredClone(crater);
      corruption.mutate(candidate);
      state.featureManifest.push(candidate);
      const stateBytes = Buffer.from(JSON.stringify(state, null, 2));
      writeFileSync(statePath, stateBytes);
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            ...originalManifest,
            stateSha256: createHash("sha256").update(stateBytes).digest("hex"),
            stateBytes: stateBytes.byteLength,
          },
          null,
          2,
        ),
      );

      const liveBefore = (await rpc("terrain.getDataset")).result;
      const restored = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
      expect.soft(restored.error?.data?.code, corruption.name).toBe(
        "TERRAIN_VALIDATION_FAILED",
      );
      if (restored.error) {
        expect.soft(
          (await rpc("terrain.getDataset")).result,
          `${corruption.name} changes live state`,
        ).toEqual(liveBefore);
      }
    }
  }, 120_000);

  it("rejects re-hashed, finite but physically invalid rock state atomically", async () => {
    await generate({ outputDirectory: join(WORK, "rock-physics-validation") });
    const snapshot = (await rpc("terrain.snapshot")).result;
    const statePath = join(snapshot.directory, snapshot.stateFile);
    const manifestPath = join(snapshot.directory, "snapshot.json");
    const originalState = JSON.parse(readFileSync(statePath, "utf8"));
    const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const originalRock = originalState.featureManifest.find(
      (feature: any) => feature.kind === "rock",
    );
    expect(originalRock).toBeDefined();
    const appliedLayer = originalRock.appliedToLayers[0];
    const snapshotDataset = (await rpc("terrain.getDataset")).result;
    const layer = snapshotDataset.layers.find(
      (candidate: any) => candidate.id === appliedLayer,
    );
    expect(layer).toBeDefined();
    const terrainExtentMeters = Math.max(
      ...snapshotDataset.layers.flatMap((candidate: any) => [
        candidate.bounds.maxX - candidate.bounds.minX,
        candidate.bounds.maxZ - candidate.bounds.minZ,
      ]),
    );

    // Move the live world away from the snapshot. A rejected restore must not
    // change any observable terrain, rock, or audit state.
    await rpc("terrain.applyOperation", {
      operation: {
        kind: "lower",
        layerId: appliedLayer,
        centerXMeters: originalRock.position.x,
        centerZMeters: originalRock.position.z,
        radiusMeters: 2,
        strengthMeters: 0.2,
      },
    });
    const captureLive = async () => ({
      dataset: (await rpc("terrain.getDataset")).result,
      rocks: (await rpc("terrain.getRocks", { maxInstances: 50_000 })).result,
      operations: (await rpc("terrain.getOperationLog")).result,
      height: (
        await rpc("terrain.getHeight", {
          x: originalRock.position.x,
          z: originalRock.position.z,
        })
      ).result,
    });
    const liveBefore = await captureLive();
    expect(liveBefore.dataset.baseline.immutableIdentitySha256).toBe(
      snapshotDataset.baseline.immutableIdentitySha256,
    );
    expect(liveBefore.dataset.baseline.worldStateSha256).not.toBe(
      snapshotDataset.baseline.worldStateSha256,
    );
    expect(liveBefore.dataset.baseline.rocks.physicsSha256).not.toBe(
      snapshotDataset.baseline.rocks.physicsSha256,
    );
    expect(
      liveBefore.dataset.baseline.layers.map((entry: any) => ({
        layerId: entry.layerId,
        disturbanceSha256: entry.disturbanceSha256,
        elevationSourceSha256: entry.elevationSourceSha256,
      })),
    ).toEqual(
      snapshotDataset.baseline.layers.map((entry: any) => ({
        layerId: entry.layerId,
        disturbanceSha256: entry.disturbanceSha256,
        elevationSourceSha256: entry.elevationSourceSha256,
      })),
    );

    const corruptions: Array<{
      name: string;
      mutate: (rock: any) => void;
    }> = [
      { name: "zero scale", mutate: (rock) => (rock.scale.x = 0) },
      {
        name: "scale larger than its terrain coverage",
        mutate: (rock) =>
          (rock.scale.x = (layer.bounds.maxX - layer.bounds.minX) * 2),
      },
      {
        name: "non-unit quaternion",
        mutate: (rock) => (rock.rotationQuaternion = [2, 0, 0, 0]),
      },
      { name: "burial above one", mutate: (rock) => (rock.buriedFraction = 1.01) },
      { name: "negative angularity", mutate: (rock) => (rock.angularity = -0.01) },
      {
        name: "centre outside declared layer coverage",
        mutate: (rock) => (rock.position.x = layer.bounds.maxX + 1),
      },
      {
        name: "entirely floating",
        mutate: (rock) => (rock.position.y += rock.scale.y * 2 + 1),
      },
      {
        name: "below the bounded terrain volume",
        mutate: (rock) =>
          (rock.position.y =
            snapshotDataset.bounds.minY - terrainExtentMeters - 1),
      },
    ];

    for (const corruption of corruptions) {
      const state = structuredClone(originalState);
      const rock = state.featureManifest.find(
        (feature: any) => feature.id === originalRock.id,
      );
      corruption.mutate(rock);
      const stateBytes = Buffer.from(JSON.stringify(state, null, 2));
      writeFileSync(statePath, stateBytes);
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            ...originalManifest,
            stateSha256: createHash("sha256").update(stateBytes).digest("hex"),
            stateBytes: stateBytes.byteLength,
          },
          null,
          2,
        ),
      );

      const restored = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
      expect(restored.error?.data?.code, corruption.name).toBe(
        "TERRAIN_VALIDATION_FAILED",
      );
      expect(await captureLive(), corruption.name).toEqual(liveBefore);
    }
  }, 120_000);

  it("forces two stale clients to re-baseline when restore reuses a branch head", async () => {
    await generate({ outputDirectory: join(WORK, "revision-branch-binding") });
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[0];
    const oldRevision = dataset.datasetRevision;

    const common = await rpc("terrain.applyOperation", {
      operation: {
        kind: "lower",
        layerId: layer.id,
        centerXMeters: -8,
        centerZMeters: -8,
        radiusMeters: 2,
        strengthMeters: 0.1,
      },
    });
    expect(common.result.delta).toMatchObject({
      datasetRevision: oldRevision,
      sequenceNumber: 0,
    });
    const snapshot = (await rpc("terrain.snapshot")).result;
    expect(snapshot.sequenceNumber).toBe(1);

    const secondClient = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((resolveOpen, reject) => {
      secondClient.once("open", resolveOpen);
      secondClient.once("error", reject);
    });
    try {
      const firstClientAtCommonHead = await rpc("terrain.getChangedSince", {
        datasetRevision: oldRevision,
        sequenceNumber: 1,
      });
      const secondClientAtCommonHead = await rpcOn(
        secondClient,
        "terrain.getChangedSince",
        { datasetRevision: oldRevision, sequenceNumber: 1 },
      );
      expect(firstClientAtCommonHead.result).toMatchObject({
        datasetRevision: oldRevision,
        fromSequence: 1,
        toSequence: 1,
        baselineRequired: false,
      });
      expect(secondClientAtCommonHead.result).toEqual(
        firstClientAtCommonHead.result,
      );

      const abandonedBranch = await rpc("terrain.applyOperation", {
        operation: {
          kind: "lower",
          layerId: layer.id,
          centerXMeters: 7,
          centerZMeters: 7,
          radiusMeters: 2,
          strengthMeters: 0.25,
        },
      });
      expect(abandonedBranch.result.delta).toMatchObject({
        datasetRevision: oldRevision,
        sequenceNumber: 1,
      });
      const staleHead = abandonedBranch.result.delta.sequenceNumber + 1;
      expect(staleHead).toBe(2);

      const restored = (
        await rpc("terrain.restoreSnapshot", { directory: snapshot.directory })
      ).result;
      expect(restored).toMatchObject({
        snapshotSequenceNumber: 1,
        nextSequence: 1,
        datasetRevision: oldRevision + 1,
      });

      const replacementBranch = await rpc("terrain.applyOperation", {
        operation: {
          kind: "raise",
          layerId: layer.id,
          centerXMeters: 7,
          centerZMeters: 7,
          radiusMeters: 2,
          strengthMeters: 0.4,
        },
      });
      expect(replacementBranch.result.delta).toMatchObject({
        datasetRevision: restored.datasetRevision,
        sequenceNumber: 1,
      });
      expect(replacementBranch.result.delta.resultingChecksum).not.toBe(
        abandonedBranch.result.delta.resultingChecksum,
      );
      expect(replacementBranch.result.delta.sequenceNumber + 1).toBe(staleHead);

      const stalePoll = await rpc("terrain.getChangedSince", {
        datasetRevision: oldRevision,
        sequenceNumber: staleHead,
      });
      expect(stalePoll.error.data).toMatchObject({
        code: "TERRAIN_VALIDATION_FAILED",
        details: {
          reason: "revision_mismatch",
          requestedRevision: oldRevision,
          currentRevision: restored.datasetRevision,
          headSequence: staleHead,
        },
      });

      const staleDeltaFetch = await rpcOn(secondClient, "terrain.getDelta", {
        datasetRevision: oldRevision,
        sequenceNumber: 1,
      });
      expect(staleDeltaFetch.error.data.details).toMatchObject({
        reason: "revision_mismatch",
        requestedRevision: oldRevision,
        currentRevision: restored.datasetRevision,
      });

      // A legacy caller that omits the revision sees the same numeric head,
      // but is explicitly forbidden from treating it as the same baseline.
      const compatibilityPoll = await rpcOn(
        secondClient,
        "terrain.getChangedSince",
        {
          sequenceNumber: staleHead,
        },
      );
      expect(compatibilityPoll.result).toMatchObject({
        datasetRevision: restored.datasetRevision,
        fromSequence: staleHead,
        toSequence: staleHead,
        baselineRequired: true,
        changedTiles: [],
      });
      expect(compatibilityPoll.result.layerChecksums).toEqual(
        (await rpc("terrain.getDataset")).result.layerChecksums,
      );

      const currentDelta = await rpc("terrain.getDelta", {
        datasetRevision: restored.datasetRevision,
        sequenceNumber: 1,
      });
      expect(currentDelta.result).toEqual(replacementBranch.result.delta);
      expect(currentDelta.result).not.toEqual(abandonedBranch.result.delta);
    } finally {
      await new Promise<void>((done) => {
        secondClient.once("close", () => done());
        secondClient.close();
      });
    }
  }, 120_000);

  it("serves a current baseline to revision-less fresh clients after restore and delta pruning", async () => {
    await generate({ outputDirectory: join(WORK, "fresh-baseline-after-restore") });
    const beforeRestore = (await rpc("terrain.getDataset")).result;
    const layer = beforeRestore.layers[0];

    await rpc("terrain.applyOperation", {
      operation: {
        kind: "lower",
        layerId: layer.id,
        centerXMeters: -12,
        centerZMeters: 9,
        radiusMeters: 2,
        strengthMeters: 0.1,
      },
    });
    const snapshot = (await rpc("terrain.snapshot")).result;
    await rpc("terrain.applyOperation", {
      operation: {
        kind: "raise",
        layerId: layer.id,
        centerXMeters: 12,
        centerZMeters: -9,
        radiusMeters: 2,
        strengthMeters: 0.2,
      },
    });
    const restored = (
      await rpc("terrain.restoreSnapshot", { directory: snapshot.directory })
    ).result;
    expect(restored.nextSequence).toBe(1);

    const freshClient = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((resolveOpen, reject) => {
      freshClient.once("open", resolveOpen);
      freshClient.once("error", reject);
    });
    let afterRestore: any;
    try {
      afterRestore = await rpcOn(freshClient, "terrain.getChangedSince", {
        sequenceNumber: 0,
      });
    } finally {
      await new Promise<void>((done) => {
        freshClient.once("close", () => done());
        freshClient.close();
      });
    }
    const restoredDataset = (await rpc("terrain.getDataset")).result;

    for (let i = 0; i <= DELTA_WINDOW; i++) {
      const edit = await rpc("terrain.applyOperation", {
        operation: {
          kind: i % 2 === 0 ? "raise" : "lower",
          layerId: layer.id,
          centerXMeters: -20 + (i % 40),
          centerZMeters: -20 + (Math.floor(i / 40) % 5) * 8,
          radiusMeters: 1.1,
          strengthMeters: 0.01,
        },
      });
      expect(edit.result?.delta.sequenceNumber).toBe(i + 1);
    }

    const afterPruningDataset = (await rpc("terrain.getDataset")).result;
    expect(afterPruningDataset.sequenceNumber).toBe(DELTA_WINDOW + 2);
    const freshAfterPruning = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((resolveOpen, reject) => {
      freshAfterPruning.once("open", resolveOpen);
      freshAfterPruning.once("error", reject);
    });
    let afterPruning: any;
    try {
      afterPruning = await rpcOn(
        freshAfterPruning,
        "terrain.getChangedSince",
        { sequenceNumber: 0 },
      );
    } finally {
      await new Promise<void>((done) => {
        freshAfterPruning.once("close", () => done());
        freshAfterPruning.close();
      });
    }

    expect.soft(afterRestore.error).toBeUndefined();
    expect.soft(afterRestore.result).toMatchObject({
      fromSequence: 0,
      toSequence: 1,
      datasetRevision: restored.datasetRevision,
      baselineRequired: true,
      changedTiles: [],
      perLayer: [],
    });
    expect.soft(afterRestore.result?.baseline).toEqual(restoredDataset.baseline);
    expect.soft(afterRestore.result?.layerChecksums).toEqual(
      restoredDataset.layerChecksums,
    );

    expect.soft(afterPruning.error).toBeUndefined();
    expect.soft(afterPruning.result).toMatchObject({
      fromSequence: 0,
      toSequence: DELTA_WINDOW + 2,
      datasetRevision: restored.datasetRevision,
      baselineRequired: true,
      changedTiles: [],
      perLayer: [],
    });
    expect.soft(afterPruning.result?.baseline).toEqual(
      afterPruningDataset.baseline,
    );
    expect.soft(afterPruning.result?.layerChecksums).toEqual(
      afterPruningDataset.layerChecksums,
    );

    const revisionBound = await rpc("terrain.getChangedSince", {
      datasetRevision: restored.datasetRevision,
      sequenceNumber: 0,
    });
    expect(revisionBound.error.data.details).toMatchObject({
      reason: "pruned",
      oldestRetained: 2,
      headSequence: DELTA_WINDOW + 2,
    });
  }, 120_000);

  it("rejects symlinked and wrong-sized real height blobs without changing live bytes", async () => {
    await generate({ outputDirectory: join(WORK, "safe-bounded-restore") });
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[0];
    await rpc("terrain.applyOperation", {
      operation: {
        kind: "lower",
        layerId: layer.id,
        centerXMeters: -5,
        centerZMeters: 5,
        radiusMeters: 2,
        strengthMeters: 0.15,
      },
    });
    const snapshot = (await rpc("terrain.snapshot")).result;

    // Diverge from the snapshot so a partial restore cannot look successful.
    await rpc("terrain.applyOperation", {
      operation: {
        kind: "raise",
        layerId: layer.id,
        centerXMeters: 5,
        centerZMeters: -5,
        radiusMeters: 3,
        strengthMeters: 0.35,
      },
    });

    const captureLiveState = async () => {
      const current = (await rpc("terrain.getDataset")).result;
      const currentLayer = current.layers[0];
      return {
        dataset: current,
        heightBytes: (
          await rpc("terrain.getTile", {
            layerId: currentLayer.id,
            channel: "height",
            col0: 0,
            row0: 0,
            width: currentLayer.widthSamples,
            height: currentLayer.heightSamples,
            stride: 1,
          })
        ).result,
        semanticBytes: (
          await rpc("terrain.getTile", {
            layerId: currentLayer.id,
            channel: "semantic",
            col0: 0,
            row0: 0,
            width: currentLayer.widthSamples,
            height: currentLayer.heightSamples,
            stride: 1,
          })
        ).result,
        rocks: (await rpc("terrain.getRocks", { maxInstances: 50_000 })).result,
        operationLog: (await rpc("terrain.getOperationLog")).result,
      };
    };
    const liveBefore = await captureLiveState();

    const heightFile = snapshot.layers[0].heightFile;
    const heightPath = join(snapshot.directory, heightFile);
    const realHeightPath = join(snapshot.directory, `${heightFile}.real`);
    renameSync(heightPath, realHeightPath);
    symlinkSync(`${heightFile}.real`, heightPath);
    let symlinkRestore: any;
    try {
      symlinkRestore = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
    } finally {
      unlinkSync(heightPath);
      renameSync(realHeightPath, heightPath);
    }
    expect(symlinkRestore.error.data.code).toBe("TERRAIN_VALIDATION_FAILED");
    expect(symlinkRestore.error.data.details.mismatches).toContainEqual(
      expect.objectContaining({
        file: heightFile,
        problem: "not a regular non-symlink file",
      }),
    );
    expect(await captureLiveState()).toEqual(liveBefore);

    const realHeightBytes = readFileSync(heightPath);
    expect(realHeightBytes.byteLength).toBe(snapshot.layers[0].heightBytes);
    writeFileSync(
      heightPath,
      realHeightBytes.subarray(0, realHeightBytes.byteLength - 4),
    );
    let shortRestore: any;
    try {
      shortRestore = await rpc("terrain.restoreSnapshot", {
        directory: snapshot.directory,
      });
    } finally {
      writeFileSync(heightPath, realHeightBytes);
    }
    expect(shortRestore.error.data.code).toBe("TERRAIN_VALIDATION_FAILED");
    expect(shortRestore.error.data.details.mismatches).toContainEqual(
      expect.objectContaining({
        file: heightFile,
        problem: "size mismatch",
        expectedBytes: realHeightBytes.byteLength,
        actualBytes: realHeightBytes.byteLength - 4,
      }),
    );
    expect(await captureLiveState()).toEqual(liveBefore);
  }, 120_000);
  it("restores a multi-layer crater site whose generator ids repeat per layer", async () => {
    // The shipped demonstration site (three layers, craters enabled) is the
    // acceptance case for snapshot restore. The crater generator numbers its
    // features per layer (crater-000000 exists once per crater-bearing layer),
    // so a validator that demands globally unique feature ids rejects every
    // real multi-layer snapshot. A small two-layer Site01 crop reproduces the
    // id scheme in seconds.
    await generate({
      terrainId: "snapshot_site01_layers",
      seed: "snapshot-site01-layers",
      outputDirectory: join(WORK, "generated-layers"),
      layers: [
        { role: "context", widthMeters: 80, lengthMeters: 80, resolutionMeters: 1 },
        { role: "operational", widthMeters: 20, lengthMeters: 20, resolutionMeters: 0.1 },
      ],
      craters: PRODUCTION_CSFD_CRATERS,
    });
    const dataset = (await rpc("terrain.getDataset")).result;
    expect(dataset.layers).toHaveLength(2);
    expect(dataset.features.craters).toBeGreaterThan(0);

    const raise = await rpc("terrain.applyOperation", {
      operation: {
        kind: "raise",
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 3,
        strengthMeters: 0.5,
        falloff: 2,
      },
    });
    expect(raise.error).toBeUndefined();
    const heightBefore = (await rpc("terrain.getHeight", { x: 0, z: 0 })).result
      .elevationM;
    const worldBefore = (await rpc("terrain.getDataset")).result.baseline
      .worldStateSha256;

    const snapshot = (await rpc("terrain.snapshot")).result;
    expect(snapshot.snapshotVersion).toBe(2);
    const state = JSON.parse(
      readFileSync(join(snapshot.directory, snapshot.stateFile), "utf8"),
    );
    // Precondition that makes this test meaningful: the real generator output
    // carries repeated crater ids across the two layers.
    const craterIds = state.featureManifest
      .filter((f: any) => f.kind === "crater")
      .map((f: any) => f.id);
    expect(new Set(craterIds).size).toBeLessThan(craterIds.length);

    const lower = await rpc("terrain.applyOperation", {
      operation: {
        kind: "lower",
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 3,
        strengthMeters: 0.7,
        falloff: 2,
      },
    });
    expect(lower.error).toBeUndefined();

    const restore = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(restore.error).toBeUndefined();
    expect(restore.result.restoredLayers).toBe(2);
    expect(restore.result.restoredFeatures).toBe(state.featureManifest.length);
    const after = (await rpc("terrain.getDataset")).result;
    expect(after.baseline.worldStateSha256).toBe(worldBefore);
    expect((await rpc("terrain.getHeight", { x: 0, z: 0 })).result.elevationM).toBe(
      heightBefore,
    );
  }, 120_000);

  it("restores after a pad and a polygonal cut through the flattened footprint", async () => {
    // Canonical construction sequence: level a pad, then cut into it. The cut's
    // pre-edit footprint is perfectly flat, so its recorded elevation stats have
    // min == max and a floating-point mean that can land a few ulps outside
    // that degenerate interval. Restore must accept the server's own record.
    const dataset = (await rpc("terrain.getDataset")).result;
    const layer = dataset.layers[dataset.layers.length - 1];
    const cx = (layer.bounds.minX + layer.bounds.maxX) / 2;
    const cz = (layer.bounds.minZ + layer.bounds.maxZ) / 2;
    const ground = (await rpc("terrain.getHeight", { x: cx, z: cz })).result
      .elevationM;

    const pad = await rpc("terrain.applyOperation", {
      operation: {
        kind: "pad",
        layerId: layer.id,
        centerXMeters: cx,
        centerZMeters: cz,
        radiusMeters: 2.5,
        strengthMeters: 0,
        falloff: 1,
        targetElevationMeters: ground + 0.2,
      },
    });
    expect(pad.error).toBeUndefined();
    const cut = await rpc("terrain.applyOperation", {
      operation: {
        kind: "polygonal_cut",
        layerId: layer.id,
        centerXMeters: cx,
        centerZMeters: cz,
        radiusMeters: 0.2,
        strengthMeters: 0,
        falloff: 1,
        targetElevationMeters: ground - 0.1,
        polygonXZ: [
          [cx - 1, cz - 1],
          [cx + 1, cz - 1],
          [cx + 1, cz + 1],
          [cx - 1, cz + 1],
        ],
      },
    });
    expect(cut.error).toBeUndefined();

    const snapshot = (await rpc("terrain.snapshot")).result;
    const state = JSON.parse(
      readFileSync(join(snapshot.directory, snapshot.stateFile), "utf8"),
    );
    const cutFeature = state.featureManifest.find(
      (f: any) => f.kind === "polygonal_cut",
    );
    expect(cutFeature).toBeDefined();
    // Precondition: the cut really did start on a flat footprint.
    expect(cutFeature.elevationBefore.min).toBe(cutFeature.elevationBefore.max);

    const worldBefore = (await rpc("terrain.getDataset")).result.baseline
      .worldStateSha256;
    const restore = await rpc("terrain.restoreSnapshot", {
      directory: snapshot.directory,
    });
    expect(restore.error).toBeUndefined();
    expect(restore.result.restoredOperations).toBe(state.operationLog.length);
    expect((await rpc("terrain.getDataset")).result.baseline.worldStateSha256).toBe(
      worldBefore,
    );
  }, 120_000);
});
