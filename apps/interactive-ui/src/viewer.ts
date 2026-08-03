/**
 * Three.js viewport (spec §13).
 *
 * ## Lunar lighting
 *
 * The Moon has no atmosphere, so there is no sky fill, no scattering and no
 * twilight. The scene is lit by a **single** directional source at the real
 * solar azimuth and elevation, with ambient held near zero. Shadows are
 * therefore black and edges are hard — which is the point: at a polar site the
 * Sun sits within 1.54° of the horizon and shadows run for tens of metres.
 *
 * Earth-like sky illumination is available but off by default, and is labelled
 * in the UI as non-physical when enabled (spec §13).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildOverlayColors, type OverlayMode } from './overlays.js';

export type CameraMode = 'orbit' | 'topdown' | 'first_person' | 'rover';

/** Rover eye height above the surface, metres — a VIPER-class deck camera. */
export const ROVER_EYE_HEIGHT_M = 1.0;

export interface LayerGeometry {
  id: string;
  role: string;
  heights: Float32Array;
  semantic?: Uint8Array;
  widthSamples: number;
  heightSamples: number;
  resolutionMeters: number;
  minX: number;
  minZ: number;
}

/**
 * Unit vector pointing **toward** the Sun in the local frame.
 *
 * Azimuth is clockwise from north and north is −Z (ADR 0002), so the ground
 * direction at azimuth A is `(sin A, −cos A)`. Getting this sign wrong mirrors
 * every shadow north-for-south.
 */
export function sunDirection(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const c = Math.cos(el);
  return new THREE.Vector3(c * Math.sin(az), Math.sin(el), -c * Math.cos(az)).normalize();
}

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  private readonly perspective: THREE.PerspectiveCamera;
  private readonly ortho: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private readonly canvas: HTMLCanvasElement;

  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly earthLight: THREE.DirectionalLight;

  private terrainGroup = new THREE.Group();
  private rockGroup = new THREE.Group();
  private helperGroup = new THREE.Group();

  /**
   * Dispose every geometry and material under a group, then clear it.
   *
   * `Group.clear()` alone only detaches children — the WebGL buffers stay
   * allocated. `loadDataset` rebuilds the terrain after every brush stroke,
   * so without disposal a 20-stroke editing session leaked on the order of a
   * gigabyte of GPU memory before the context was lost.
   */
  private static disposeGroup(group: THREE.Group): void {
    group.traverse((obj) => {
      const mesh = obj as Partial<THREE.Mesh> & { geometry?: THREE.BufferGeometry };
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (obj as Partial<THREE.Mesh>).material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) (mat as THREE.Material).dispose();
    });
    group.clear();
  }

  private layers: LayerGeometry[] = [];
  private meshes = new Map<string, THREE.Mesh>();

  cameraMode: CameraMode = 'orbit';
  overlayMode: OverlayMode = 'lit';
  wireframe = false;
  siteExtentM = 100;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Airless: no tone-mapped sky, and a linear response so the deep shadows
    // stay genuinely dark rather than being lifted by a filmic curve.
    this.renderer.toneMapping = THREE.NoToneMapping;

    // Space, not sky.
    this.scene.background = new THREE.Color(0x000000);

    this.perspective = new THREE.PerspectiveCamera(50, 1, 0.05, 20000);
    this.perspective.position.set(30, 20, 30);
    this.ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 20000);
    this.ortho.position.set(0, 500, 0);
    this.ortho.lookAt(0, 0, 0);

    this.sun = new THREE.DirectionalLight(0xfff6e8, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Near-zero: a sliver of light bounced off surrounding regolith, enough to
    // keep shadowed geometry from being pure void, far below Earth-like fill.
    this.ambient = new THREE.AmbientLight(0x404048, 0.06);
    this.scene.add(this.ambient);

    // Earthshine, off by default. Roughly 40x brighter than full moonlight on
    // Earth but ~1e-4 of sunlight, so it is a faint blue-grey fill.
    this.earthLight = new THREE.DirectionalLight(0x7090c0, 0.0);
    this.earthLight.position.set(-1, 0.3, 1);
    this.scene.add(this.earthLight);

    this.scene.add(this.terrainGroup);
    this.scene.add(this.rockGroup);
    this.scene.add(this.helperGroup);

    this.controls = new OrbitControls(this.perspective, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
  }

  get camera(): THREE.Camera {
    return this.cameraMode === 'topdown' ? this.ortho : this.perspective;
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / Math.max(1, height);
    this.perspective.updateProjectionMatrix();
    const half = this.siteExtentM / 2;
    const aspect = width / Math.max(1, height);
    this.ortho.left = -half * aspect;
    this.ortho.right = half * aspect;
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  /** Position the Sun from real ephemeris angles. */
  setSolar(azimuthDeg: number, elevationDeg: number): void {
    const dir = sunDirection(azimuthDeg, elevationDeg);
    const distance = Math.max(200, this.siteExtentM * 4);
    this.sun.position.copy(dir.clone().multiplyScalar(distance));
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();

    // Below the horizon the surface receives no direct light at all.
    this.sun.intensity = elevationDeg > 0 ? 3.2 : 0.0;

    // Shadow frustum sized to the site; the default 100-unit box would waste
    // the atlas on empty space and stair-step every shadow edge.
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    const half = this.siteExtentM * 0.75;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = distance * 2.5;
    cam.updateProjectionMatrix();
  }

  setEarthshine(enabled: boolean): void {
    this.earthLight.intensity = enabled ? 0.05 : 0.0;
  }

  setAmbient(intensity: number): void {
    this.ambient.intensity = intensity;
  }

  /** Replace the terrain with a new set of layers. */
  setLayers(layers: LayerGeometry[]): void {
    this.layers = layers;
    Viewer.disposeGroup(this.terrainGroup);
    this.meshes.clear();

    let extent = 1;
    for (const layer of layers) {
      extent = Math.max(extent, (layer.widthSamples - 1) * layer.resolutionMeters);
      const mesh = this.buildLayerMesh(layer);
      this.meshes.set(layer.id, mesh);
      this.terrainGroup.add(mesh);
    }
    this.siteExtentM = extent;

    this.controls.target.set(0, 0, 0);
    this.frameSite();
  }

  /**
   * Build a mesh for one layer.
   *
   * Winding is `(v00, v01, v11)` and `(v00, v11, v10)`, matching the GLB
   * exporter and the Godot loader, so all three agree on which way is up.
   */
  private buildLayerMesh(layer: LayerGeometry): THREE.Mesh {
    // Cap preview density: a 3001² operational layer is 9M vertices, far past
    // what a browser should hold for a preview (spec §14).
    const maxSide = 512;
    const step = Math.max(
      1,
      Math.ceil(Math.max(layer.widthSamples, layer.heightSamples) / maxSide),
    );
    const w = Math.floor((layer.widthSamples - 1) / step) + 1;
    const h = Math.floor((layer.heightSamples - 1) / step) + 1;

    const positions = new Float32Array(w * h * 3);
    const decimated = new Float32Array(w * h);
    const decimatedSemantic = layer.semantic ? new Uint8Array(w * h) : undefined;

    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const gc = Math.min(c * step, layer.widthSamples - 1);
        const gr = Math.min(r * step, layer.heightSamples - 1);
        const y = layer.heights[gr * layer.widthSamples + gc];
        const i = (r * w + c) * 3;
        positions[i] = layer.minX + gc * layer.resolutionMeters;
        positions[i + 1] = y;
        positions[i + 2] = layer.minZ + gr * layer.resolutionMeters;
        decimated[r * w + c] = y;
        if (decimatedSemantic && layer.semantic) {
          decimatedSemantic[r * w + c] = layer.semantic[gr * layer.widthSamples + gc];
        }
      }
    }

    const indices = new Uint32Array((w - 1) * (h - 1) * 6);
    let k = 0;
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const i00 = r * w + c;
        const i10 = r * w + c + 1;
        const i01 = (r + 1) * w + c;
        const i11 = (r + 1) * w + c + 1;
        indices[k++] = i00;
        indices[k++] = i01;
        indices[k++] = i11;
        indices[k++] = i00;
        indices[k++] = i11;
        indices[k++] = i10;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    const colors = buildOverlayColors(
      this.overlayMode,
      decimated,
      w,
      h,
      layer.resolutionMeters * step,
      decimatedSemantic,
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mesh = new THREE.Mesh(geometry, this.materialFor(this.overlayMode));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = layer.id;
    mesh.userData = { layerId: layer.id, decimated, w, h, step };
    return mesh;
  }

  /**
   * Material for an overlay mode.
   *
   * `lit` is a physically shaded surface under the solar light. **Every other
   * mode is unlit**, because they are analysis views: a slope or traversability
   * map that goes black whenever the Sun drops below the horizon is useless,
   * and at this site the Sun is below the horizon for much of the month. The
   * false-colour value must read the same regardless of illumination.
   */
  private materialFor(mode: OverlayMode): THREE.Material {
    if (mode === 'lit') {
      return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.98,
        metalness: 0.0,
        wireframe: this.wireframe,
      });
    }
    return new THREE.MeshBasicMaterial({
      vertexColors: true,
      wireframe: this.wireframe,
    });
  }

  setOverlay(mode: OverlayMode): void {
    const wasLit = this.overlayMode === 'lit';
    this.overlayMode = mode;
    if (wasLit !== (mode === 'lit')) {
      for (const mesh of this.meshes.values()) {
        (mesh.material as THREE.Material).dispose();
        mesh.material = this.materialFor(mode);
      }
    }
    for (const layer of this.layers) {
      const mesh = this.meshes.get(layer.id);
      if (!mesh) continue;
      const { decimated, w, h, step } = mesh.userData as {
        decimated: Float32Array;
        w: number;
        h: number;
        step: number;
      };
      let semantic: Uint8Array | undefined;
      if (layer.semantic) {
        semantic = new Uint8Array(w * h);
        for (let r = 0; r < h; r++) {
          for (let c = 0; c < w; c++) {
            const gc = Math.min(c * step, layer.widthSamples - 1);
            const gr = Math.min(r * step, layer.heightSamples - 1);
            semantic[r * w + c] = layer.semantic[gr * layer.widthSamples + gc];
          }
        }
      }
      const colors = buildOverlayColors(
        mode,
        decimated,
        w,
        h,
        layer.resolutionMeters * step,
        semantic,
      );
      const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      attr.array.set(colors);
      attr.needsUpdate = true;
    }
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    for (const mesh of this.meshes.values()) {
      const m = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
      m.wireframe = on;
      m.needsUpdate = true;
    }
  }

  /** Instance rocks as a MultiMesh-equivalent (spec §9). */
  setRocks(
    rocks: Array<{
      position_m: number[];
      scale_m: number[];
      rotation_quaternion: number[];
      physical: boolean;
    }>,
  ): void {
    Viewer.disposeGroup(this.rockGroup);
    if (rocks.length === 0) return;

    const geometry = new THREE.IcosahedronGeometry(1, 1);
    for (const physical of [true, false]) {
      const subset = rocks.filter((r) => r.physical === physical);
      if (subset.length === 0) continue;
      const material = new THREE.MeshStandardMaterial({
        color: physical ? 0x2a2724 : 0x24211e,
        roughness: 0.95,
        metalness: 0,
        flatShading: true,
      });
      const inst = new THREE.InstancedMesh(geometry, material, subset.length);
      inst.name = physical ? 'PhysicalRocks' : 'VisualRocks';
      inst.castShadow = true;
      inst.receiveShadow = true;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      for (let i = 0; i < subset.length; i++) {
        const r = subset[i];
        p.set(r.position_m[0], r.position_m[1], r.position_m[2]);
        q.set(
          r.rotation_quaternion[0],
          r.rotation_quaternion[1],
          r.rotation_quaternion[2],
          r.rotation_quaternion[3],
        );
        s.set(r.scale_m[0], r.scale_m[1], r.scale_m[2]);
        m.compose(p, q, s);
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      this.rockGroup.add(inst);
    }
  }

  /** Grid, layer boundaries and contour lines (spec §13). */
  setHelpers(options: { grid: boolean; tileBounds: boolean; contours: boolean }): void {
    Viewer.disposeGroup(this.helperGroup);

    if (options.grid) {
      const size = Math.ceil(this.siteExtentM);
      const grid = new THREE.GridHelper(size, Math.min(100, Math.max(4, Math.round(size / 10))));
      (grid.material as THREE.Material).opacity = 0.18;
      (grid.material as THREE.Material).transparent = true;
      this.helperGroup.add(grid);
    }

    if (options.tileBounds) {
      for (const layer of this.layers) {
        const w = (layer.widthSamples - 1) * layer.resolutionMeters;
        const h = (layer.heightSamples - 1) * layer.resolutionMeters;
        const points = [
          new THREE.Vector3(layer.minX, 0, layer.minZ),
          new THREE.Vector3(layer.minX + w, 0, layer.minZ),
          new THREE.Vector3(layer.minX + w, 0, layer.minZ + h),
          new THREE.Vector3(layer.minX, 0, layer.minZ + h),
          new THREE.Vector3(layer.minX, 0, layer.minZ),
        ];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const color =
          layer.role === 'operational' ? 0x00ff9f : layer.role === 'mission' ? 0xffc400 : 0x4aa3ff;
        this.helperGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
      }
    }

    if (options.contours) this.buildContours();
  }

  /** Contour lines by marching-squares on the coarsest layer. */
  private buildContours(): void {
    const layer = this.layers.reduce(
      (a, b) => (a.resolutionMeters >= b.resolutionMeters ? a : b),
      this.layers[0],
    );
    if (!layer) return;

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < layer.heights.length; i++) {
      if (layer.heights[i] < min) min = layer.heights[i];
      if (layer.heights[i] > max) max = layer.heights[i];
    }
    const span = max - min;
    if (!Number.isFinite(span) || span <= 0) return;

    // Aim for ~12 contours at a round interval.
    const raw = span / 12;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const interval = magnitude * (raw / magnitude < 2 ? 1 : raw / magnitude < 5 ? 2 : 5);

    const points: THREE.Vector3[] = [];
    const step = Math.max(1, Math.floor(layer.widthSamples / 256));
    const at = (c: number, r: number) => layer.heights[r * layer.widthSamples + c];
    const worldX = (c: number) => layer.minX + c * layer.resolutionMeters;
    const worldZ = (r: number) => layer.minZ + r * layer.resolutionMeters;

    for (let level = Math.ceil(min / interval) * interval; level < max; level += interval) {
      for (let r = 0; r + step < layer.heightSamples; r += step) {
        for (let c = 0; c + step < layer.widthSamples; c += step) {
          const h00 = at(c, r);
          const h10 = at(c + step, r);
          const h01 = at(c, r + step);
          // Horizontal crossing.
          if (h00 < level !== h10 < level) {
            const t = (level - h00) / (h10 - h00);
            points.push(
              new THREE.Vector3(worldX(c + t * step), level + 0.02, worldZ(r)),
              new THREE.Vector3(worldX(c + t * step), level + 0.02, worldZ(r) + 0.001),
            );
          }
          // Vertical crossing.
          if (h00 < level !== h01 < level) {
            const t = (level - h00) / (h01 - h00);
            points.push(
              new THREE.Vector3(worldX(c), level + 0.02, worldZ(r + t * step)),
              new THREE.Vector3(worldX(c) + 0.001, level + 0.02, worldZ(r + t * step)),
            );
          }
        }
      }
    }
    if (points.length === 0) return;
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    this.helperGroup.add(
      new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.35, transparent: true }),
      ),
    );
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    const extent = this.siteExtentM;
    switch (mode) {
      case 'topdown':
        this.ortho.position.set(0, Math.max(100, extent), 0);
        this.ortho.lookAt(0, 0, 0);
        this.controls.enabled = false;
        break;
      case 'rover':
        // Eye height above the surface at the origin — the view a rover mast
        // camera actually has, where grazing light and long shadows dominate.
        this.perspective.position.set(0, this.surfaceHeightAt(0, 0) + ROVER_EYE_HEIGHT_M, 0);
        this.perspective.lookAt(extent * 0.25, this.surfaceHeightAt(extent * 0.25, 0), 0);
        this.controls.enabled = true;
        this.controls.target.set(extent * 0.25, this.surfaceHeightAt(extent * 0.25, 0), 0);
        break;
      case 'first_person':
        this.perspective.position.set(extent * 0.1, this.surfaceHeightAt(0, 0) + 1.7, extent * 0.1);
        this.controls.enabled = true;
        this.controls.target.set(0, this.surfaceHeightAt(0, 0), 0);
        break;
      case 'orbit':
      default:
        this.controls.enabled = true;
        this.frameSite();
        break;
    }
  }

  private frameSite(): void {
    const d = Math.max(10, this.siteExtentM * 0.7);
    this.perspective.position.set(d * 0.7, d * 0.5, d * 0.7);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Bilinear surface height from the finest layer covering a point. */
  surfaceHeightAt(x: number, z: number): number {
    let best: LayerGeometry | undefined;
    for (const layer of this.layers) {
      const maxX = layer.minX + (layer.widthSamples - 1) * layer.resolutionMeters;
      const maxZ = layer.minZ + (layer.heightSamples - 1) * layer.resolutionMeters;
      if (x < layer.minX || x > maxX || z < layer.minZ || z > maxZ) continue;
      if (!best || layer.resolutionMeters < best.resolutionMeters) best = layer;
    }
    if (!best) return 0;
    const fc = (x - best.minX) / best.resolutionMeters;
    const fr = (z - best.minZ) / best.resolutionMeters;
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, best.widthSamples - 1);
    const r1 = Math.min(r0 + 1, best.heightSamples - 1);
    const tc = fc - c0;
    const tr = fr - r0;
    const W = best.widthSamples;
    return (
      best.heights[r0 * W + c0] * (1 - tc) * (1 - tr) +
      best.heights[r0 * W + c1] * tc * (1 - tr) +
      best.heights[r1 * W + c0] * (1 - tc) * tr +
      best.heights[r1 * W + c1] * tc * tr
    );
  }

  /** Ray-pick the terrain under a normalised device coordinate. */
  pick(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hits = raycaster.intersectObjects(this.terrainGroup.children, false);
    return hits.length > 0 ? hits[0].point : null;
  }

  render(): void {
    if (this.controls.enabled) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** PNG data URL of the current frame, for the Playwright visual check. */
  snapshot(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}
