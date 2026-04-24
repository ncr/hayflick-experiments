import * as THREE from "three";
import {
  EDGE_DETECTION_DEBUG_MODES,
  EdgeDetectionMaterial,
  type EdgeDetectionDebugMode,
  type SuppressMode
} from "./edge-detection-material";
import { LinearDepthMaterial } from "./linear-depth-material";
import { OutlineGroupMaterial } from "./outline-group-material";
import { WorldPositionMaterial } from "./world-position-material";
import type { IsoGameView } from "../iso-game-view";
import type { PixelPerfectPane } from "../stage/pixel-perfect-pane";

/**
 * A render host the outline pipeline can attach to. {@link IsoGameView} is
 * the single-pane facade; {@link PixelPerfectPane} is the multi-pane
 * building block (e.g. the 3D preview pane in the map editor).
 */
export type OutlineHost = IsoGameView | PixelPerfectPane;

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
  /**
   * Suppression is skipped when the linear-depth delta exceeds this value.
   * Default 1.0 world unit. Only used when `suppressMode` is `"depth"`.
   */
  suppressDepthEps: number;
  /**
   * Suppression is skipped when the world-space distance between fragments
   * exceeds this value. Default 0.1 (10 cm). Only used when `suppressMode`
   * is `"world-position"`.
   */
  suppressWorldEps: number;
  /**
   * Which same-surface test to use for flush-seam suppression.
   * - `"world-position"` (default): per-fragment world-space distance.
   *   Camera-invariant and architecturally unambiguous — two parallel
   *   surfaces that alias at the same camera depth still distinguish
   *   cleanly. Costs one half-float RGBA G-buffer pass.
   * - `"depth"`: camera-space depth delta. Cheaper (no extra RT) but
   *   fails when two parallel surfaces sit at the same camera depth.
   */
  suppressMode: SuppressMode;
  /** Multiplier applied to outlined pixel color. Default 1.35. */
  outlineBrightness: number;
  /** How much of the brightened color to mix in (0..1). Default 1.0. */
  outlineMix: number;
};

export const OutlineDefaults: Readonly<OutlineTuning> = Object.freeze({
  depthThreshold: 0.05,
  normalThreshold: 0.3,
  idSuppressNormalDot: 0.5,
  suppressDepthEps: 1.0,
  suppressWorldEps: 0.1,
  suppressMode: "world-position",
  outlineBrightness: 1.35,
  outlineMix: 1.0
});

export type OutlinePipelineConfig = {
  /**
   * View or pane to attach to. The pipeline takes over the host's
   * `beforeSceneRender` / `afterSceneRender` and drives its low target.
   */
  view: OutlineHost;
  scene: THREE.Scene;
  clearColor: number;
  clearAlpha: number;
  tuning?: Partial<OutlineTuning>;
  debugMode?: EdgeDetectionDebugMode;
};

type MeshEntry = {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  idMaterial: OutlineGroupMaterial;
};

/**
 * The 4-pass outline pipeline: color → normals → linear depth → ids →
 * edge-composite. Attaches itself to a {@link IsoGameView} by taking over
 * its beforeSceneRender/afterSceneRender hooks and driving its setLowTarget /
 * setOutputSourceTexture. Dispose with {@link dispose} to restore the view.
 */
export class OutlinePipeline {
  private readonly view: OutlineHost;
  private readonly scene: THREE.Scene;
  private readonly originalLowTarget: THREE.WebGLRenderTarget;
  private readonly colorTarget: THREE.WebGLRenderTarget;
  private readonly normalTarget: THREE.WebGLRenderTarget;
  private readonly depthPackedTarget: THREE.WebGLRenderTarget;
  private readonly worldPosTarget: THREE.WebGLRenderTarget;
  private readonly idTarget: THREE.WebGLRenderTarget;
  private readonly postTarget: THREE.WebGLRenderTarget;
  private readonly normalMaterial: THREE.MeshNormalMaterial;
  private readonly depthMaterial: LinearDepthMaterial;
  private readonly worldPosMaterial: WorldPositionMaterial;
  private readonly postMaterial: EdgeDetectionMaterial;
  private readonly postScene: THREE.Scene;
  private readonly postCamera: THREE.OrthographicCamera;
  private readonly postQuad: THREE.Mesh;
  private readonly idGroups = new Map<number, OutlineGroupMaterial>();
  private readonly meshEntries = new Map<THREE.Mesh, MeshEntry>();
  private readonly clearColorHex: number;
  private readonly clearAlpha: number;
  private readonly prevBeforeSceneRender:
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null;
  private readonly prevAfterSceneRender:
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null;
  // State captured in beforeSceneRender; restored in afterSceneRender so the
  // outline pipeline's tone-mapping switch is bounded by the scene-render pair
  // and does not leak across panes in a shared-stage scene.
  private savedToneMapping: THREE.ToneMapping = THREE.NoToneMapping;
  private disposed = false;

  constructor(config: OutlinePipelineConfig) {
    this.view = config.view;
    this.scene = config.scene;
    this.clearColorHex = config.clearColor;
    this.clearAlpha = config.clearAlpha;

    const initialLow = this.view.getLowTarget();
    this.originalLowTarget = initialLow;
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
    this.view.setLowTarget(this.colorTarget, { disposePrevious: false });

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

    this.worldPosTarget = new THREE.WebGLRenderTarget(
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
    this.worldPosTarget.texture.generateMipmaps = false;

    this.normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    this.depthMaterial = new LinearDepthMaterial(this.view.camera.near, this.view.camera.far);
    this.worldPosMaterial = new WorldPositionMaterial();

    const tuning = { ...OutlineDefaults, ...(config.tuning ?? {}) };
    this.postMaterial = new EdgeDetectionMaterial({
      colorTexture: this.colorTarget.texture,
      depthTexture: this.depthPackedTarget.texture,
      normalTexture: this.normalTarget.texture,
      idTexture: this.idTarget.texture,
      worldPosTexture: this.worldPosTarget.texture,
      resolution: { x: this.colorTarget.width, y: this.colorTarget.height },
      near: this.view.camera.near,
      far: this.view.camera.far,
      depthThreshold: tuning.depthThreshold,
      normalThreshold: tuning.normalThreshold,
      idSuppressNormalDot: tuning.idSuppressNormalDot,
      suppressDepthEps: tuning.suppressDepthEps,
      suppressWorldEps: tuning.suppressWorldEps,
      suppressMode: tuning.suppressMode,
      outlineBrightness: tuning.outlineBrightness,
      outlineMix: tuning.outlineMix
    });
    this.postMaterial.setDebugMode(config.debugMode ?? "final");

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);

    this.prevBeforeSceneRender = this.view.beforeSceneRender;
    this.prevAfterSceneRender = this.view.afterSceneRender;
    const prevBefore = this.prevBeforeSceneRender;
    const prevAfter = this.prevAfterSceneRender;

    // Chain order: run any pre-existing hook first, then outline's own setup.
    // Restore is the mirror image — run outline's restore first, then the
    // pre-existing hook's restore. This keeps nested before/after pairs
    // correctly scoped (outline is the outer wrap).
    //
    // Only the tone-mapping mode is swapped here; `toneMappingExposure` is
    // left alone so consumers can control PBR exposure via `renderer`.
    this.view.beforeSceneRender = (renderer, lowTarget) => {
      prevBefore?.(renderer, lowTarget);
      this.savedToneMapping = renderer.toneMapping;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    };
    this.view.afterSceneRender = (renderer, lowTarget) => {
      try {
        this.renderOutlinePasses(renderer, lowTarget);
      } finally {
        renderer.toneMapping = this.savedToneMapping;
        prevAfter?.(renderer, lowTarget);
      }
    };
  }

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

  setIdSuppression(state: "on" | "off"): void {
    this.postMaterial.uniforms.uIdSuppressNormalDot.value = state === "on" ? 0.5 : 2.0;
  }

  setSuppressMode(mode: SuppressMode): void {
    this.postMaterial.uniforms.uSuppressMode.value = mode === "world-position" ? 1 : 0;
  }

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

  debugReadAuxSamples(bufX: number, bufY: number, stride = 1): OutlineAuxProbe {
    const w = this.depthPackedTarget.width;
    const h = this.depthPackedTarget.height;
    const clampX = Math.max(0, Math.min(w - 1, bufX | 0));
    const clampY = Math.max(0, Math.min(h - 1, bufY | 0));
    const sx = Math.max(1, stride | 0);
    const depthBuf = new Uint16Array(w * h * 4);
    this.view.renderer.readRenderTargetPixels(this.depthPackedTarget, 0, 0, w, h, depthBuf);
    const normalBuf = new Uint8Array(w * h * 4);
    this.view.renderer.readRenderTargetPixels(this.normalTarget, 0, 0, w, h, normalBuf);
    const idBuf = new Uint8Array(w * h * 4);
    this.view.renderer.readRenderTargetPixels(this.idTarget, 0, 0, w, h, idBuf);
    const near = this.view.camera.near;
    const far = this.view.camera.far;
    const readOne = (x: number, y: number): OutlineAuxSample => {
      const offset = (y * w + x) * 4;
      const depthNorm = halfToFloat32(depthBuf[offset]);
      const viewZ = depthNorm * (far - near) + near;
      return {
        x,
        y,
        depthNorm,
        viewZ,
        normal: [normalBuf[offset] / 255, normalBuf[offset + 1] / 255, normalBuf[offset + 2] / 255],
        id: [idBuf[offset] / 255, idBuf[offset + 1] / 255, idBuf[offset + 2] / 255]
      };
    };
    let renderedCount = 0;
    let depthMin = Infinity;
    let depthMax = -Infinity;
    for (let i = 0; i < depthBuf.length; i += 4) {
      const d = halfToFloat32(depthBuf[i]);
      if (d < 0.999) {
        renderedCount++;
        if (d < depthMin) depthMin = d;
        if (d > depthMax) depthMax = d;
      }
    }
    return {
      width: w,
      height: h,
      near,
      far,
      renderedFraction: renderedCount / (w * h),
      depthRange: renderedCount > 0 ? [depthMin, depthMax] : null,
      center: readOne(clampX, clampY),
      left: clampX - sx >= 0 ? readOne(clampX - sx, clampY) : null,
      right: clampX + sx < w ? readOne(clampX + sx, clampY) : null,
      up: clampY - sx >= 0 ? readOne(clampX, clampY - sx) : null,
      down: clampY + sx < h ? readOne(clampX, clampY + sx) : null
    };
  }

  private renderOutlinePasses(
    renderer: THREE.WebGLRenderer,
    lowTarget: THREE.WebGLRenderTarget
  ): void {
    this.syncAuxTargets(lowTarget);

    const savedOverrideMaterial = this.scene.overrideMaterial;
    const savedBackground = this.scene.background;
    let idMaterialsInstalled = false;

    try {
      renderer.toneMapping = THREE.NoToneMapping;

      this.scene.overrideMaterial = this.normalMaterial;
      renderer.setRenderTarget(this.normalTarget);
      renderer.clear();
      renderer.render(this.scene, this.view.camera);

      this.scene.background = null;
      this.scene.overrideMaterial = this.depthMaterial;
      renderer.setRenderTarget(this.depthPackedTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this.scene, this.view.camera);

      this.scene.overrideMaterial = this.worldPosMaterial;
      renderer.setRenderTarget(this.worldPosTarget);
      renderer.setClearColor(0x808080, 1);
      renderer.clear();
      renderer.render(this.scene, this.view.camera);

      renderer.setClearColor(this.clearColorHex, this.clearAlpha);

      this.scene.overrideMaterial = null;
      for (const entry of this.meshEntries.values()) {
        entry.mesh.material = entry.idMaterial;
      }
      idMaterialsInstalled = true;
      renderer.setRenderTarget(this.idTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(this.scene, this.view.camera);
      this.restoreOriginalMeshMaterials();
      idMaterialsInstalled = false;
      renderer.setClearColor(this.clearColorHex, this.clearAlpha);

      renderer.setRenderTarget(this.postTarget);
      renderer.clear();
      renderer.render(this.postScene, this.postCamera);
    } finally {
      if (idMaterialsInstalled) {
        this.restoreOriginalMeshMaterials();
      }
      this.scene.overrideMaterial = savedOverrideMaterial;
      this.scene.background = savedBackground;
    }

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
    if (this.worldPosTarget.width !== w || this.worldPosTarget.height !== h) {
      this.worldPosTarget.setSize(w, h);
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
    this.view.beforeSceneRender = this.prevBeforeSceneRender;
    this.view.afterSceneRender = this.prevAfterSceneRender;
    this.view.setOutputSourceTexture(null);
    this.view.setLowTarget(this.originalLowTarget, { disposePrevious: false });
    this.normalTarget.dispose();
    this.idTarget.dispose();
    this.depthPackedTarget.dispose();
    this.worldPosTarget.dispose();
    this.postTarget.dispose();
    this.colorTarget.dispose();
    this.depthMaterial.dispose();
    this.worldPosMaterial.dispose();
    this.normalMaterial.dispose();
    this.postMaterial.dispose();
    this.postQuad.geometry.dispose();
    this.postScene.remove(this.postQuad);
    for (const groupMaterial of this.idGroups.values()) {
      groupMaterial.dispose();
    }
    this.idGroups.clear();
    this.meshEntries.clear();
  }

  private restoreOriginalMeshMaterials(): void {
    for (const entry of this.meshEntries.values()) {
      entry.mesh.material = entry.originalMaterial;
    }
  }
}

export type OutlineAuxSample = {
  x: number;
  y: number;
  depthNorm: number;
  viewZ: number;
  normal: [number, number, number];
  id: [number, number, number];
};

export type OutlineAuxProbe = {
  width: number;
  height: number;
  near: number;
  far: number;
  renderedFraction: number;
  depthRange: [number, number] | null;
  center: OutlineAuxSample;
  left: OutlineAuxSample | null;
  right: OutlineAuxSample | null;
  up: OutlineAuxSample | null;
  down: OutlineAuxSample | null;
};

function halfToFloat32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function hashGroupKey(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 1 + (h % 65535);
}
