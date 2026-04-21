import * as THREE from "three";
import { PixelPerfectView } from "../pixel-perfect-view";
import type { PixelPerfectViewConfig } from "../pixel-perfect-types";
import {
  EDGE_DETECTION_DEBUG_MODES,
  EdgeDetectionMaterial,
  type EdgeDetectionDebugMode
} from "./edge-detection-material";
import { LinearDepthMaterial } from "./linear-depth-material";
import { OutlineGroupMaterial } from "./outline-group-material";

export type OutlineTuning = {
  /** Linear-depth difference (world units) that counts as a silhouette. Default 0.05. */
  depthThreshold: number;
  /** `1 - dot(n1, n2)` above this creates a normal crease edge. Default 0.3. */
  normalThreshold: number;
  /**
   * Same-group pixels whose normals match by at least this dot value get their
   * edge suppressed. Default 0.5. Set >= 2 (e.g. the value exposed as
   * `"off"` via {@link setIdSuppression}) to show all seams.
   */
  idSuppressNormalDot: number;
  /** Multiplier applied to outlined pixel color. Default 1.35. */
  outlineBrightness: number;
  /** How much of the brightened color to mix in (0..1). Default 1.0. */
  outlineMix: number;
};

export const OutlineDefaults: Readonly<OutlineTuning> = Object.freeze({
  depthThreshold: 0.05,
  normalThreshold: 0.3,
  idSuppressNormalDot: 0.5,
  outlineBrightness: 1.35,
  outlineMix: 1.0
});

export type PixelPerfectOutlinedViewConfig = PixelPerfectViewConfig & {
  outline?: Partial<OutlineTuning>;
  /**
   * Initial debug mode. Default `"final"` (full outline composite).
   */
  debugMode?: EdgeDetectionDebugMode;
};

type MeshEntry = {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  idMaterial: OutlineGroupMaterial;
};

/**
 * `PixelPerfectView` + a 4-pass outline post-process (color → normals → linear
 * depth → ids → edge-detect composite).
 *
 * Minimal usage:
 *
 * ```ts
 * const view = new PixelPerfectOutlinedView({ mount, scene, width, height });
 * view.assignOutlineGroup(meshA, "wall");
 * view.assignOutlineGroup(meshB, "glass");
 * // drive the RAF loop:
 * view.frame(now, dt);
 * ```
 *
 * Group ids are stable hashes of the string keys you pass — same string →
 * same numeric id → same silhouette-suppressed surface.
 */
export class PixelPerfectOutlinedView {
  readonly view: PixelPerfectView;

  private readonly scene: THREE.Scene;
  private readonly colorTarget: THREE.WebGLRenderTarget;
  private readonly normalTarget: THREE.WebGLRenderTarget;
  private readonly depthPackedTarget: THREE.WebGLRenderTarget;
  private readonly idTarget: THREE.WebGLRenderTarget;
  private readonly postTarget: THREE.WebGLRenderTarget;
  private readonly normalMaterial: THREE.MeshNormalMaterial;
  private readonly depthMaterial: LinearDepthMaterial;
  private readonly postMaterial: EdgeDetectionMaterial;
  private readonly postScene: THREE.Scene;
  private readonly postCamera: THREE.OrthographicCamera;
  private readonly postQuad: THREE.Mesh;
  private readonly idGroups = new Map<number, OutlineGroupMaterial>();
  private readonly meshEntries = new Map<THREE.Mesh, MeshEntry>();
  private readonly clearColorHex: number;
  private readonly clearAlpha: number;
  private disposed = false;

  constructor(config: PixelPerfectOutlinedViewConfig) {
    this.view = new PixelPerfectView(config);
    this.scene = config.scene;
    this.clearColorHex = config.clearColor ?? 0x0b0f14;
    this.clearAlpha = config.clearAlpha ?? 1;

    const initialLow = this.view.getLowTarget();
    const depthTexture = new THREE.DepthTexture(
      initialLow.width,
      initialLow.height,
      THREE.UnsignedIntType
    );
    this.colorTarget = new THREE.WebGLRenderTarget(initialLow.width, initialLow.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false,
      depthBuffer: true,
      depthTexture
    });
    this.colorTarget.texture.generateMipmaps = false;
    this.view.setLowTarget(this.colorTarget);

    const makeAuxTarget = (w: number, h: number) => {
      const t = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        stencilBuffer: false
      });
      t.texture.generateMipmaps = false;
      return t;
    };

    this.normalTarget = makeAuxTarget(this.colorTarget.width, this.colorTarget.height);
    this.idTarget = makeAuxTarget(this.colorTarget.width, this.colorTarget.height);
    this.postTarget = makeAuxTarget(this.colorTarget.width, this.colorTarget.height);

    // HalfFloat keeps the 16-bit depth precision that the edge threshold needs.
    this.depthPackedTarget = new THREE.WebGLRenderTarget(
      this.colorTarget.width,
      this.colorTarget.height,
      {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        stencilBuffer: false
      }
    );
    this.depthPackedTarget.texture.generateMipmaps = false;

    this.normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    this.depthMaterial = new LinearDepthMaterial(this.view.camera.near, this.view.camera.far);

    const tuning = { ...OutlineDefaults, ...(config.outline ?? {}) };
    this.postMaterial = new EdgeDetectionMaterial({
      colorTexture: this.colorTarget.texture,
      depthTexture: this.depthPackedTarget.texture,
      normalTexture: this.normalTarget.texture,
      idTexture: this.idTarget.texture,
      resolution: { x: this.colorTarget.width, y: this.colorTarget.height },
      near: this.view.camera.near,
      far: this.view.camera.far,
      depthThreshold: tuning.depthThreshold,
      normalThreshold: tuning.normalThreshold,
      idSuppressNormalDot: tuning.idSuppressNormalDot,
      outlineBrightness: tuning.outlineBrightness,
      outlineMix: tuning.outlineMix
    });
    this.postMaterial.setDebugMode(config.debugMode ?? "final");

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);

    this.view.beforeSceneRender = (renderer) => {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
    };
    this.view.afterSceneRender = (renderer, lowTarget) => {
      this.renderOutlinePasses(renderer, lowTarget);
    };
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  get camera(): THREE.OrthographicCamera {
    return this.view.camera;
  }

  get canvas(): HTMLCanvasElement {
    return this.view.canvas;
  }

  get renderer(): THREE.WebGLRenderer {
    return this.view.renderer;
  }

  get cameraTarget(): THREE.Vector3 {
    return this.view.cameraTarget;
  }

  frame(nowMs: number, deltaSeconds: number): void {
    this.view.frame(nowMs, deltaSeconds);
  }

  resize(width: number, height: number): void {
    this.view.resize(width, height);
  }

  /**
   * Assign `mesh` to an outline group identified by `groupKey`. Every mesh
   * sharing the same key gets the same id, so their coplanar seams are
   * suppressed in the composite. Keys are hashed to small integers internally.
   */
  assignOutlineGroup(mesh: THREE.Mesh, groupKey: string | number): void {
    const groupId = typeof groupKey === "number" ? groupKey : hashGroupKey(groupKey);
    let material = this.idGroups.get(groupId);
    if (!material) {
      material = new OutlineGroupMaterial(groupId);
      this.idGroups.set(groupId, material);
    }
    const existing = this.meshEntries.get(mesh);
    if (existing) {
      existing.idMaterial = material;
      return;
    }
    this.meshEntries.set(mesh, {
      mesh,
      originalMaterial: mesh.material,
      idMaterial: material
    });
  }

  /**
   * Walk `root` and assign every descendant mesh to a group chosen by
   * `classify(mesh)`. Return `null` to skip a mesh.
   */
  assignOutlineGroupsUnder(
    root: THREE.Object3D,
    classify: (mesh: THREE.Mesh) => string | number | null
  ): void {
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const key = classify(obj);
      if (key === null) return;
      this.assignOutlineGroup(obj, key);
    });
  }

  setDebugMode(mode: EdgeDetectionDebugMode): void {
    this.postMaterial.setDebugMode(mode);
  }

  cycleDebugMode(): EdgeDetectionDebugMode {
    const current = (this.postMaterial.uniforms.uDebugMode.value as number) | 0;
    const next = (current + 1) % EDGE_DETECTION_DEBUG_MODES.length;
    const mode = EDGE_DETECTION_DEBUG_MODES[next];
    this.postMaterial.setDebugMode(mode);
    return mode;
  }

  /**
   * Turn id-based seam suppression on or off at runtime.
   *
   * - `"on"`: coplanar same-group seams suppress (default).
   * - `"off"`: every seam draws, regardless of group.
   */
  setIdSuppression(state: "on" | "off"): void {
    this.postMaterial.uniforms.uIdSuppressNormalDot.value = state === "on" ? 0.5 : 2.0;
  }

  /**
   * Read the final composited low-resolution buffer back to CPU. Forces a GPU
   * stall, so reserve for test / diagnostic paths, not hot loops.
   */
  readLowResolutionPixels(out?: Uint8Array): {
    width: number;
    height: number;
    pixels: Uint8Array;
  } {
    const w = this.postTarget.width;
    const h = this.postTarget.height;
    const buffer = out && out.length === w * h * 4 ? out : new Uint8Array(w * h * 4);
    this.view.renderer.readRenderTargetPixels(this.postTarget, 0, 0, w, h, buffer);
    return { width: w, height: h, pixels: buffer };
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private renderOutlinePasses(
    renderer: THREE.WebGLRenderer,
    lowTarget: THREE.WebGLRenderTarget
  ): void {
    this.syncAuxTargets(lowTarget);

    renderer.toneMapping = THREE.NoToneMapping;

    // Pass 2: normals.
    this.scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(this.normalTarget);
    renderer.clear();
    renderer.render(this.scene, this.view.camera);
    this.scene.overrideMaterial = null;

    // Pass 2b: linear view-z depth into R. Null out scene.background for this
    // pass — otherwise three.js writes the background colour into the depth
    // target (converted sRGB→linear), giving a background depth near 0.01 and
    // flipping every silhouette direction. Clear to white (=far plane) instead.
    const savedBackground = this.scene.background;
    this.scene.background = null;
    this.scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.depthPackedTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.scene, this.view.camera);
    this.scene.overrideMaterial = null;
    this.scene.background = savedBackground;
    renderer.setClearColor(this.clearColorHex, this.clearAlpha);

    // Pass 3: ids. Swap mesh materials to their id materials, render, restore.
    for (const entry of this.meshEntries.values()) {
      entry.mesh.material = entry.idMaterial;
    }
    renderer.setRenderTarget(this.idTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.scene, this.view.camera);
    for (const entry of this.meshEntries.values()) {
      entry.mesh.material = entry.originalMaterial;
    }
    renderer.setClearColor(this.clearColorHex, this.clearAlpha);

    // Pass 4: edge-detect composite.
    renderer.setRenderTarget(this.postTarget);
    renderer.clear();
    renderer.render(this.postScene, this.postCamera);

    this.view.setOutputSourceTexture(this.postTarget.texture);
  }

  private syncAuxTargets(lowTarget: THREE.WebGLRenderTarget): void {
    const w = lowTarget.width;
    const h = lowTarget.height;
    if (this.normalTarget.width !== w || this.normalTarget.height !== h) {
      this.normalTarget.setSize(w, h);
    }
    if (this.idTarget.width !== w || this.idTarget.height !== h) {
      this.idTarget.setSize(w, h);
    }
    if (this.depthPackedTarget.width !== w || this.depthPackedTarget.height !== h) {
      this.depthPackedTarget.setSize(w, h);
    }
    if (this.postTarget.width !== w || this.postTarget.height !== h) {
      this.postTarget.setSize(w, h);
    }
    this.postMaterial.setResolution(w, h);
    this.postMaterial.setRange(this.view.camera.near, this.view.camera.far);
    this.depthMaterial.setRange(this.view.camera.near, this.view.camera.far);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view.beforeSceneRender = null;
    this.view.afterSceneRender = null;
    this.view.setOutputSourceTexture(null);
    this.normalTarget.dispose();
    this.idTarget.dispose();
    this.depthPackedTarget.dispose();
    this.postTarget.dispose();
    this.colorTarget.dispose();
    this.depthMaterial.dispose();
    this.normalMaterial.dispose();
    this.postMaterial.dispose();
    this.postQuad.geometry.dispose();
    this.postScene.remove(this.postQuad);
    for (const groupMaterial of this.idGroups.values()) {
      groupMaterial.dispose();
    }
    this.idGroups.clear();
    this.meshEntries.clear();
    this.view.dispose();
  }
}

/** Deterministic hash from a string key into a small-int group id (0..65535). */
function hashGroupKey(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Reserve 0 for "no group" / background. 1..65535 for callers.
  return 1 + (h % 65535);
}
