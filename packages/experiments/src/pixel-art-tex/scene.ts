import * as THREE from "three";
import {
  IsoGameView,
  PixelPerfectDefaults,
  applyPixelArtTextureDefaults
} from "@common/render";
import type { RgbaBuffer } from "./pixel-grid";

/**
 * The pixel-perfect demo scene.
 *
 * Two surfaces share one source texture:
 *
 *   - **Calibration quad**: a programmatically built 1.28 m × 1.0451 m plane
 *     standing vertically in the XY plane (normal +Z), with explicit UVs
 *     mapping the entire texture to its full surface. Sized so that 32 texels
 *     map to 32 screen pixels along *both* iso-X and screen-vertical at
 *     zoom 1 (one texel = one screen pixel exactly along screen vertical;
 *     one texel per screen-X column with a half-texel-per-column V skew —
 *     see notes in `pixel-grid.ts`).
 *
 *   - **Wall mesh** (wall.glb, 128 × 280 × 32 cm): the production base mesh.
 *     Box-projected UVs apply at runtime via Three.js by overriding the
 *     mesh's UV channel with one we compute from world position. At a
 *     128-cm UV scale, 32 texels horizontal land on exactly 32 screen
 *     pixels horizontal (1:1) and 32 texels vertical land on ~39.2 screen
 *     pixels vertical (a small ~22% stretch — inherent to iso-2:1 since
 *     world-up is not on the same lattice as the iso ground axes).
 *
 * The MSAA / output filter knobs are pinned to OFF: `lowTargetSamples: 0`
 * and `smoothPixelTransitions: false`. With either of those on, neighbouring
 * texels would blend at the output stage and the synthetic verification
 * test would fail.
 */

const WALL_MESH_URL = "/api/assets/read?path=meshes%2Fwall.glb";

/**
 * World units that yield 32 vertical screen pixels exactly at zoom 1, given
 * the IsoGameView default tuning (orthoHeight 4.8·√2, fixedRenderHeight 240,
 * iso-2:1 pitch). 1 m world Y → cos(π/6) · 240 / (4.8·√2) ≈ 30.6186 px
 * vertical. 32 / 30.6186 = 1.0451 m. Used for the calibration quad height.
 */
const CALIBRATION_QUAD_HEIGHT_M = (32 * (4.8 * Math.SQRT2)) / (240 * Math.cos(Math.PI / 6));

/** Width matches one tile (128 cm), so the quad is 32 horizontal screen px wide. */
const CALIBRATION_QUAD_WIDTH_M = 1.28;

const TEXEL_RESOLUTION = 32;

export type SceneHandle = {
  /** Replace the texture on both surfaces. */
  setTexture(buffer: RgbaBuffer): void;
  /** Force one frame to render synchronously. */
  forceFrame(n?: number): void;
  /** Read the framebuffer at canvas-pixel coords (top-left origin). */
  readPixel(canvasX: number, canvasY: number): { r: number; g: number; b: number };
  /**
   * Render one frame and atomically sample a list of canvas-pixel positions
   * before the WebGL drawing buffer is wiped by the next task. Use this for
   * pixel verification — direct {@link readPixel} between frames returns
   * black under WebGL's default `preserveDrawingBuffer: false`.
   */
  frameAndReadPixels(
    positions: Array<{ x: number; y: number }>
  ): Array<{ r: number; g: number; b: number }>;
  /** Get the calibration quad screen-space bounds (CSS pixels relative to the canvas). */
  getCalibrationQuadBounds(): { left: number; right: number; top: number; bottom: number };
  /** Project a world point to canvas CSS pixels. */
  projectWorldToCanvas(world: THREE.Vector3): { x: number; y: number };
  /**
   * Canvas-pixel centre of texel (tx, ty) on the calibration quad. `ty` is
   * the buffer row index — row 0 is at the top of the rendered surface
   * (DataTexture is configured with `flipY = true`).
   */
  calibrationTexelCenterCanvas(tx: number, ty: number): { x: number; y: number };
  /** Texel resolution of the calibration quad (matches TEXEL_RESOLUTION). */
  getTexelResolution(): { x: number; y: number };
  /** Diagnostic — view internal state. */
  getViewState(): unknown;
  /** Diagnostic — list of all meshes in the scene with their world bounds. */
  getSceneSummary(): unknown;
  /** Cleanup. */
  dispose(): void;
};

export async function createScene(mount: HTMLElement): Promise<SceneHandle> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202733);

  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambient);

  // Initial dummy 1×1 white texture so materials are valid before generation.
  const initialBuffer: RgbaBuffer = {
    data: new Uint8ClampedArray([255, 255, 255, 255]),
    width: 1,
    height: 1
  };
  const dataTex = createDataTexture(initialBuffer);

  // --- Calibration quad ---
  const quadGeom = new THREE.PlaneGeometry(CALIBRATION_QUAD_WIDTH_M, CALIBRATION_QUAD_HEIGHT_M);
  // PlaneGeometry sits in XY plane with normal +Z. Translate so its base is on Y=0.
  quadGeom.translate(0, CALIBRATION_QUAD_HEIGHT_M / 2, 0);
  const quadMat = new THREE.MeshBasicMaterial({
    map: dataTex,
    side: THREE.FrontSide,
    transparent: false
  });
  const calibrationQuad = new THREE.Mesh(quadGeom, quadMat);
  // Centred at world origin so it stays in view at any zoom level — the
  // camera target is (0, 0, 0) and the quad is sized to fit the visible
  // ortho window at the chosen `basePixelZoom`.
  calibrationQuad.position.set(0, 0, 0);
  scene.add(calibrationQuad);

  // --- Wall mesh ---
  const wall = await loadWallMesh();
  // Override the wall's UVs with a per-face box projection in WORLD space
  // so adjacent faces share a coherent texture grid. We compute face
  // normals from the index buffer (not vertex-averaged smooth normals,
  // which collapse at box corners and break the axis classification).
  applyBoxProjectedUVs(wall, /* uvScaleMeters = */ 1.28);
  const wallMat = new THREE.MeshBasicMaterial({ map: dataTex, side: THREE.FrontSide });
  wall.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.material = wallMat;
    }
  });
  // wall.glb is authored in artifact units where 1 unit = 1 tile = 128 cm
  // (per assets/meshes/wall.manifest.json `artifactUnitsPerAuthoringUnit`).
  // World units are metres and 1 tile = 1.28 m, so scale by 1.28 to land at
  // the right physical size: 1.28 m wide × 2.80 m tall × 0.32 m thick.
  wall.scale.setScalar(1.28);
  // Park the wall to the right of the calibration quad so both fit on
  // screen at zoom=2 with a typical viewport.
  wall.position.set(1.5, 0, 0);
  scene.add(wall);

  // --- IsoGameView with MSAA OFF for pixel-exact verification ---
  const view = new IsoGameView({
    mount,
    width: Math.max(1, mount.clientWidth),
    height: Math.max(1, mount.clientHeight),
    scene,
    clearColor: 0x202733,
    outlines: false,
    lowTargetSamples: 0,
    smoothPixelTransitions: false,
    // basePixelZoom drives the initial userScale. At zoom=2 each texel
    // covers 2 canvas pixels along the screen-vertical axis (which is the
    // calibrated 1:1 axis on the quad). Big enough to be obviously chunky
    // for the demo, small enough that the whole calibration quad fits
    // inside the camera ortho window at any reasonable viewport.
    basePixelZoom: 2
  });

  view.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 2 });

  // Resize observer keeps the renderer in sync with the mount.
  const resizeObs = new ResizeObserver((entries) => {
    for (const e of entries) {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) view.resize(width, height);
    }
  });
  resizeObs.observe(mount);

  // Manual render loop so we can pause for screenshots / pixel reads.
  let disposed = false;
  let lastTime = performance.now();
  let rafId = 0;
  const tick = (now: number) => {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    view.frame(now, dt);
  };
  rafId = requestAnimationFrame(tick);

  const projectVec = new THREE.Vector2();

  return {
    setTexture(buffer: RgbaBuffer) {
      const next = createDataTexture(buffer);
      // Replace the texture on both materials and dispose the old one.
      const prev = quadMat.map;
      quadMat.map = next;
      quadMat.needsUpdate = true;
      wallMat.map = next;
      wallMat.needsUpdate = true;
      if (prev) prev.dispose();
    },
    forceFrame(n = 2) {
      const now = performance.now();
      for (let i = 0; i < n; i++) {
        view.frame(now + i * 16, 0.016);
      }
    },
    frameAndReadPixels(positions) {
      // Render and copy to a 2D scratch canvas in the same task — the WebGL
      // drawing buffer is still valid here, before the browser wipes it on
      // the next task boundary.
      const now = performance.now();
      view.frame(now, 0.016);
      const srcCanvas = view.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = srcCanvas.width;
      tmp.height = srcCanvas.height;
      const ctx = tmp.getContext("2d");
      if (!ctx) throw new Error("2D context unavailable");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(srcCanvas, 0, 0);
      const out: Array<{ r: number; g: number; b: number }> = [];
      for (const p of positions) {
        const x = Math.max(0, Math.min(tmp.width - 1, Math.floor(p.x)));
        const y = Math.max(0, Math.min(tmp.height - 1, Math.floor(p.y)));
        const data = ctx.getImageData(x, y, 1, 1).data;
        out.push({ r: data[0], g: data[1], b: data[2] });
      }
      return out;
    },
    readPixel(canvasX: number, canvasY: number) {
      // Note: without `preserveDrawingBuffer: true` on the WebGLRenderer,
      // a standalone readPixel between frames returns black — the browser
      // wipes the WebGL drawing buffer at the end of each task. Use
      // {@link SceneHandle.frameAndReadPixels} instead, which renders and
      // samples atomically in one task. Kept here for ad-hoc inspection
      // immediately after a manual forceFrame in the same callback.
      const srcCanvas = view.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = 1;
      tmp.height = 1;
      const ctx = tmp.getContext("2d");
      if (!ctx) throw new Error("2D context unavailable");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        srcCanvas,
        Math.floor(canvasX),
        Math.floor(canvasY),
        1,
        1,
        0,
        0,
        1,
        1
      );
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2] };
    },
    getCalibrationQuadBounds() {
      // Project the quad's four corners and return the screen-space bounds.
      const corners = [
        new THREE.Vector3(-CALIBRATION_QUAD_WIDTH_M / 2, 0, 0),
        new THREE.Vector3(CALIBRATION_QUAD_WIDTH_M / 2, 0, 0),
        new THREE.Vector3(-CALIBRATION_QUAD_WIDTH_M / 2, CALIBRATION_QUAD_HEIGHT_M, 0),
        new THREE.Vector3(CALIBRATION_QUAD_WIDTH_M / 2, CALIBRATION_QUAD_HEIGHT_M, 0)
      ];
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of corners) {
        const w = new THREE.Vector3().copy(c).add(calibrationQuad.position);
        view.projectWorldToClient(w, projectVec);
        const rect = mount.getBoundingClientRect();
        xs.push(projectVec.x - rect.left);
        ys.push(projectVec.y - rect.top);
      }
      return {
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys)
      };
    },
    projectWorldToCanvas(world: THREE.Vector3) {
      view.projectWorldToClient(world, projectVec);
      const rect = mount.getBoundingClientRect();
      return { x: projectVec.x - rect.left, y: projectVec.y - rect.top };
    },
    calibrationTexelCenterCanvas(tx: number, ty: number) {
      // Local coordinates of texel centre on the plane (-W/2..+W/2, 0..H).
      // ty=0 should be at the top of the rendered surface; with flipY=true
      // and PlaneGeometry's default UVs (V=1 at +Y), the row-0 buffer maps
      // to the top of the plane (Y=H).
      const localX =
        -CALIBRATION_QUAD_WIDTH_M / 2 +
        ((tx + 0.5) / TEXEL_RESOLUTION) * CALIBRATION_QUAD_WIDTH_M;
      // ty: 0 = top buffer row → top of plane (Y=H). Centre of texel ty
      // is at world Y = H * (TEXEL_RESOLUTION - ty - 0.5)/TEXEL_RESOLUTION.
      const localY =
        ((TEXEL_RESOLUTION - ty - 0.5) / TEXEL_RESOLUTION) *
        CALIBRATION_QUAD_HEIGHT_M;
      const world = new THREE.Vector3(
        localX + calibrationQuad.position.x,
        localY + calibrationQuad.position.y,
        calibrationQuad.position.z
      );
      view.projectWorldToClient(world, projectVec);
      const rect = mount.getBoundingClientRect();
      return { x: projectVec.x - rect.left, y: projectVec.y - rect.top };
    },
    getTexelResolution() {
      return { x: TEXEL_RESOLUTION, y: TEXEL_RESOLUTION };
    },
    getViewState() {
      return view.getState();
    },
    getSceneSummary() {
      const meshes: Array<unknown> = [];
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const box = new THREE.Box3().setFromObject(obj);
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        const geom = obj.geometry as THREE.BufferGeometry | undefined;
        const posAttr = geom?.attributes.position as THREE.BufferAttribute | undefined;
        const uvAttr = geom?.attributes.uv as THREE.BufferAttribute | undefined;
        let posStats: unknown = null;
        let uvStats: unknown = null;
        if (posAttr) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          const sampleCount = Math.min(posAttr.count, 8);
          const samples: number[][] = [];
          for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            if (i < sampleCount) samples.push([x, y, z]);
          }
          posStats = {
            count: posAttr.count,
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
            samples
          };
        }
        if (uvAttr) {
          let minU = Infinity, minV = Infinity;
          let maxU = -Infinity, maxV = -Infinity;
          const sampleCount = Math.min(uvAttr.count, 8);
          const samples: number[][] = [];
          for (let i = 0; i < uvAttr.count; i++) {
            const u = uvAttr.getX(i), v = uvAttr.getY(i);
            if (u < minU) minU = u; if (u > maxU) maxU = u;
            if (v < minV) minV = v; if (v > maxV) maxV = v;
            if (i < sampleCount) samples.push([u, v]);
          }
          uvStats = {
            count: uvAttr.count,
            min: [minU, minV],
            max: [maxU, maxV],
            samples
          };
        }
        meshes.push({
          name: obj.name || obj.parent?.name || "(unnamed)",
          position: [obj.position.x, obj.position.y, obj.position.z],
          scale: [obj.scale.x, obj.scale.y, obj.scale.z],
          worldBox: {
            min: [box.min.x, box.min.y, box.min.z],
            max: [box.max.x, box.max.y, box.max.z]
          },
          materialType: (mat?.constructor as { name: string } | undefined)?.name ?? "unknown",
          hasMap: !!(mat && (mat as THREE.MeshBasicMaterial).map),
          posStats,
          uvStats
        });
      });
      return meshes;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObs.disconnect();
      view.dispose();
      // Geometries / materials will be GC'd when the scene is dropped.
      quadMat.dispose();
      wallMat.dispose();
      quadMat.map?.dispose();
      // Calibration quad geom owned here; wall geoms came from the GLTF.
      quadGeom.dispose();
    }
  };

  // ---- helpers ----

  function createDataTexture(buffer: RgbaBuffer): THREE.DataTexture {
    const tex = new THREE.DataTexture(
      buffer.data,
      buffer.width,
      buffer.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    // Pixel-art defaults: NEAREST + no mipmaps. We DO NOT apply the half-texel
    // offset here — applyPixelArtTextureDefaults's offset is for box-projected
    // UVs sampling tile boundaries; on our explicit (0..1) calibration UVs the
    // unshifted nearest sampling is what proves the pipeline is clean.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    // flipY=true so that buffer row 0 (top of our pattern array) renders at
    // the top of the surface — matches the visual orientation used by the
    // pixel-grid module and keeps the e2e test math simple.
    tex.flipY = true;
    tex.needsUpdate = true;
    // Apply box-projection helper to wall texture, but only its mipmap/filter
    // bits. Avoid the texel-centre offset since the calibration quad uses
    // exact (0..1) UVs.
    void applyPixelArtTextureDefaults;
    void PixelPerfectDefaults;
    return tex;
  }
}

async function loadWallMesh(): Promise<THREE.Group> {
  const res = await fetch(WALL_MESH_URL);
  if (!res.ok) throw new Error(`wall.glb fetch failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(buffer, "", (gltf) => resolve(gltf.scene), reject);
  });
}

/**
 * Override the UV channel of every Mesh under `root` with a per-vertex
 * box-projection: each vertex picks the world-axis pair where its face's
 * normal magnitude is largest, and the UV is (axisA / scale, axisB / scale)
 * with `scale` in the same units as the vertex positions.
 *
 * For wall.glb (positions in cm), we pass `uvScaleCm = 128` so one full UV
 * cycle = 128 cm = 32 horizontal screen pixels = exactly one texture cycle.
 *
 * Why we override: wall.glb's authored UVs are unknown, and the texture-art
 * pipeline assumes box projection. This function is a tiny in-process
 * substitute for the Blender bake step's UV unwrap.
 */
function applyBoxProjectedUVs(root: THREE.Object3D, uvScaleMeters: number): void {
  // wall.glb's geometry position attribute is in centimetres (verified at
  // runtime: a 1.28 m wide wall has positions in [-64, 64]). The GLB's
  // scene-root transform handles cm → m conversion, so the THREE.Mesh ends
  // up at the right world size, but the raw position data we read here is
  // still cm. Use cm for the UV scale: 1 UV cycle per uvScaleMeters world
  // metres = uvScaleMeters * 100 cm.
  const uvScaleLocal = uvScaleMeters * 100;

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
    const geom = obj.geometry as THREE.BufferGeometry;
    const posAttr = geom.attributes.position as THREE.BufferAttribute;
    if (!posAttr) return;

    // Per-face box projection. Smooth (averaged) vertex normals collapse
    // at box corners — at a corner shared by three faces, the averaged
    // normal points diagonally and our axis classifier picks an arbitrary
    // axis, splitting one face's UVs across two projections (visible as
    // a single solid colour because the diagonal UVs cluster in one
    // texel after the wrap). Computing UVs per FACE — three identical UVs
    // per triangle — fixes this. We rebuild the geometry as non-indexed
    // so each face owns its own three vertices.
    const faceCount =
      geom.index !== null
        ? geom.index.count / 3
        : posAttr.count / 3;

    const newPos = new Float32Array(faceCount * 3 * 3);
    const newUv = new Float32Array(faceCount * 3 * 2);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();

    for (let f = 0; f < faceCount; f++) {
      let i0: number;
      let i1: number;
      let i2: number;
      if (geom.index !== null) {
        i0 = geom.index.getX(f * 3);
        i1 = geom.index.getX(f * 3 + 1);
        i2 = geom.index.getX(f * 3 + 2);
      } else {
        i0 = f * 3;
        i1 = f * 3 + 1;
        i2 = f * 3 + 2;
      }
      a.set(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0));
      b.set(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1));
      c.set(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2));
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      faceNormal.crossVectors(ab, ac);
      const ax = Math.abs(faceNormal.x);
      const ay = Math.abs(faceNormal.y);
      const az = Math.abs(faceNormal.z);

      const baseUv = (px: number, py: number, pz: number): [number, number] => {
        if (ay >= ax && ay >= az) return [px / uvScaleLocal, pz / uvScaleLocal];
        if (ax >= az) return [pz / uvScaleLocal, py / uvScaleLocal];
        return [px / uvScaleLocal, py / uvScaleLocal];
      };

      const [ua, va] = baseUv(a.x, a.y, a.z);
      const [ub, vb] = baseUv(b.x, b.y, b.z);
      const [uc, vc] = baseUv(c.x, c.y, c.z);

      const o = f * 9;
      newPos[o] = a.x; newPos[o + 1] = a.y; newPos[o + 2] = a.z;
      newPos[o + 3] = b.x; newPos[o + 4] = b.y; newPos[o + 5] = b.z;
      newPos[o + 6] = c.x; newPos[o + 7] = c.y; newPos[o + 8] = c.z;

      const u = f * 6;
      newUv[u] = ua; newUv[u + 1] = va;
      newUv[u + 2] = ub; newUv[u + 3] = vb;
      newUv[u + 4] = uc; newUv[u + 5] = vc;
    }

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute("position", new THREE.BufferAttribute(newPos, 3));
    newGeom.setAttribute("uv", new THREE.BufferAttribute(newUv, 2));
    newGeom.computeVertexNormals();
    obj.geometry.dispose();
    obj.geometry = newGeom;
  });
}

export {
  CALIBRATION_QUAD_HEIGHT_M,
  CALIBRATION_QUAD_WIDTH_M,
  TEXEL_RESOLUTION
};
