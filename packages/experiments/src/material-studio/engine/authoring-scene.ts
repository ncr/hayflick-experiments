import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { IsoGameView } from "@common/render";
import { bindIsoGameViewInput } from "@common/input";
import { DEFAULT_PBR_TWEAK, type GeneratedMaps, type GlassParams, type PbrTweakParams, type Surface, type SubmeshUvData } from "../types";
import {
  applyPbrTweakToGroup,
  applyTexturesToGroup,
  createTextureSet,
  imageDataToCanvasTexture,
  updateCanvasTexture,
  type TextureSet,
} from "../texture-swap";

const gltfLoader = new GLTFLoader();

const KEY_RADIUS = 20;
const KEY_HEIGHT = 18;
/** Static angle for the key light. The light no longer orbits — keeping it
 *  stationary means the directional shadow map can be cached (autoUpdate=false)
 *  instead of re-rendered every frame, which is what was making the panel
 *  stutter during interaction. */
const KEY_ANGLE = Math.PI * 0.25;

function createGroundPlane(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(8, 8);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.position.y = -0.001;
  return mesh;
}

function stripBlockstudioTextures(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      if (!mat.name.startsWith("blockstudio_")) continue;
      mat.map?.dispose?.();
      mat.normalMap?.dispose?.();
      mat.aoMap?.dispose?.();
      mat.roughnessMap?.dispose?.();
      mat.metalnessMap?.dispose?.();
      mat.map = null;
      mat.normalMap = null;
      mat.aoMap = null;
      mat.roughnessMap = null;
      mat.metalnessMap = null;
      mat.color = new THREE.Color(0x9a9a9a);
      mat.roughness = 0.7;
      mat.metalness = 0;
      mat.needsUpdate = true;
    }
  });
}

type DiscoveryResult = {
  surfaces: Surface[];
  uvData: Map<string, SubmeshUvData>;
  meshes: Map<string, THREE.Mesh>;
};

function discoverSurfaces(group: THREE.Object3D): DiscoveryResult {
  const byRole = new Map<string, Surface>();
  const uvData = new Map<string, SubmeshUvData>();
  const meshes = new Map<string, THREE.Mesh>();
  group.traverse((obj) => {
    const role = obj.userData?.textureRole as string | undefined;
    if (!role || byRole.has(role)) return;
    const isGlass = role === "accent";
    byRole.set(role, {
      role,
      kind: isGlass ? "synthetic" : "pbr",
      synthetic: isGlass ? "glass" : undefined,
    });
    if (!isGlass && obj instanceof THREE.Mesh) {
      const data = extractSubmeshUvData(obj, role);
      if (data) {
        uvData.set(role, data);
        meshes.set(role, obj);
      }
    }
  });
  return { surfaces: Array.from(byRole.values()), uvData, meshes };
}

function extractSubmeshUvData(mesh: THREE.Mesh, role: string): SubmeshUvData | null {
  const geom = mesh.geometry;
  if (!(geom instanceof THREE.BufferGeometry)) return null;
  const uvAttr = geom.attributes.uv;
  if (!uvAttr) return null;
  const posAttr = geom.attributes.position;
  if (!posAttr) return null;
  const vertexCount = uvAttr.count;
  const uvBuffer = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    uvBuffer[i * 2] = uvAttr.getX(i);
    uvBuffer[i * 2 + 1] = uvAttr.getY(i);
  }
  const positionBuffer = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positionBuffer[i * 3] = posAttr.getX(i);
    positionBuffer[i * 3 + 1] = posAttr.getY(i);
    positionBuffer[i * 3 + 2] = posAttr.getZ(i);
  }
  const indexAttr = geom.index;
  let indexBuffer: Uint32Array | Uint16Array;
  if (indexAttr) {
    const src = indexAttr.array;
    if (src instanceof Uint32Array) indexBuffer = new Uint32Array(src);
    else indexBuffer = new Uint16Array(src as ArrayLike<number>);
  } else {
    indexBuffer = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indexBuffer[i] = i;
  }
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const materialName =
    mat instanceof THREE.Material && mat.name ? mat.name : `blockstudio_${role}`;
  return { indexBuffer, uvBuffer, positionBuffer, vertexCount, materialName };
}

async function loadBaseMeshGroup(meshId: string): Promise<THREE.Group> {
  const url = `/api/assets/read?path=${encodeURIComponent(`meshes/${meshId}.glb`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load mesh ${meshId}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    gltfLoader.parse(buffer, "", resolve, reject);
  });
  return gltf.scene;
}

function applyGlassMaterial(group: THREE.Object3D, roleKey: string, params: GlassParams): void {
  const targetName = `blockstudio_${roleKey}`;
  const tint = new THREE.Color(params.tint);
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (let i = 0; i < mats.length; i++) {
      const orig = mats[i];
      if (!(orig instanceof THREE.MeshStandardMaterial)) continue;
      if (orig.name !== targetName) continue;
      const physical = new THREE.MeshPhysicalMaterial({
        color: tint,
        roughness: params.roughness,
        metalness: 0,
        ior: params.ior,
        transmission: 1,
        thickness: 0.1,
        transparent: true,
        opacity: params.alpha,
      });
      physical.name = targetName;
      if (Array.isArray(obj.material)) obj.material[i] = physical;
      else obj.material = physical;
    }
  });
}

export class AuthoringScene {
  private scene: THREE.Scene;
  private view: IsoGameView;
  private unbindInput: () => void;
  private keyLight: THREE.DirectionalLight;
  private meshGroup = new THREE.Group();
  private textures = new Map<string, TextureSet>();
  private submeshUvData = new Map<string, SubmeshUvData>();
  private submeshMeshes = new Map<string, THREE.Mesh>();
  private originalUvBuffers = new Map<string, Float32Array>();
  private resizeObs: ResizeObserver;
  private animId = 0;
  private lastTime = performance.now();
  private disposed = false;
  private lightOrbitEnabled = false;
  private lightOrbitSpeed = 0.6; // radians/second
  private lightAngle = KEY_ANGLE;

  constructor(container: HTMLElement) {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.scene = new THREE.Scene();
    this.scene.add(createGroundPlane());
    this.scene.add(this.meshGroup);

    this.keyLight = new THREE.DirectionalLight(0xfff1d6, 2.8);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    const s = 6;
    this.keyLight.shadow.camera.left = -s;
    this.keyLight.shadow.camera.right = s;
    this.keyLight.shadow.camera.top = s;
    this.keyLight.shadow.camera.bottom = -s;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 80;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    this.keyLight.position.set(
      Math.cos(KEY_ANGLE) * KEY_RADIUS,
      KEY_HEIGHT,
      Math.sin(KEY_ANGLE) * KEY_RADIUS
    );
    // Render the shadow map once per scene change; not every frame.
    this.keyLight.shadow.autoUpdate = false;
    this.keyLight.shadow.needsUpdate = true;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.scene.add(new THREE.HemisphereLight(0xa9c6ff, 0x4d3a26, 0.85));
    const rim = new THREE.DirectionalLight(0x9ec6ff, 2.2);
    rim.position.set(-14, 5, -16);
    this.scene.add(rim);
    this.scene.add(rim.target);

    this.view = new IsoGameView({
      mount: container,
      width,
      height,
      scene: this.scene,
      basePixelZoom: 1,
      zoomMin: 1,
      zoomMax: 4,
      zoomStep: 1,
      rotationAnimationRate: 20,
      rotationAnimationEpsilon: 0.08,
      lowTargetSamples: 1,
      outlines: false,
      clearColor: 0x0f1115,
      toneMapping: "aces",
      shadows: true,
    });
    this.view.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.unbindInput = bindIsoGameViewInput({ view: this.view });

    this.resizeObs = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width: w, height: h } = e.contentRect;
        if (w > 0 && h > 0) this.view.resize(w, h);
      }
    });
    this.resizeObs.observe(container);

    const frame = (now: number) => {
      if (this.disposed) return;
      this.animId = requestAnimationFrame(frame);
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      if (this.lightOrbitEnabled) {
        this.lightAngle += this.lightOrbitSpeed * dt;
        this.keyLight.position.set(
          Math.cos(this.lightAngle) * KEY_RADIUS,
          KEY_HEIGHT,
          Math.sin(this.lightAngle) * KEY_RADIUS
        );
        this.keyLight.shadow.needsUpdate = true;
      }
      this.view.frame(now, dt);
    };
    this.animId = requestAnimationFrame(frame);
  }

  /**
   * Toggle a slow azimuth orbit on the key light. Useful in the studio for
   * revealing relief from normal/AO maps. Shadow-map updates are
   * re-enabled per frame only while orbiting; the static-shadow caching
   * (autoUpdate=false) is restored when the orbit stops.
   */
  setLightOrbit(opts: { enabled: boolean; speed?: number }): void {
    this.lightOrbitEnabled = opts.enabled;
    if (opts.speed !== undefined) this.lightOrbitSpeed = opts.speed;
    this.keyLight.shadow.autoUpdate = opts.enabled;
    if (!opts.enabled) {
      // Snap back to the canonical static angle so the cached shadow map
      // matches the visible light direction.
      this.lightAngle = KEY_ANGLE;
      this.keyLight.position.set(
        Math.cos(KEY_ANGLE) * KEY_RADIUS,
        KEY_HEIGHT,
        Math.sin(KEY_ANGLE) * KEY_RADIUS
      );
      this.keyLight.shadow.needsUpdate = true;
    }
  }

  private requestShadowUpdate(): void {
    this.keyLight.shadow.needsUpdate = true;
  }

  async loadBaseMesh(meshId: string): Promise<Surface[]> {
    const group = await loadBaseMeshGroup(meshId);
    this.clearMesh();
    const box = new THREE.Box3().setFromObject(group);
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    group.position.set(-centre.x, -box.min.y, -centre.z);
    stripBlockstudioTextures(group);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.meshGroup.add(group);
    const { surfaces, uvData, meshes } = discoverSurfaces(group);
    this.submeshUvData = uvData;
    this.submeshMeshes = meshes;
    for (const [role, data] of uvData) {
      this.originalUvBuffers.set(role, new Float32Array(data.uvBuffer));
    }
    this.requestShadowUpdate();
    return surfaces;
  }

  /**
   * Replace the role's submesh UV attribute. Pass `newUvBuffer` (length =
   * vertexCount × 2, atlas-space [0,1]) to point the mesh at the packed
   * atlas; pass `null` to restore the original GLB UVs.
   */
  applyAtlasUvs(role: string, newUvBuffer: Float32Array | null): void {
    const mesh = this.submeshMeshes.get(role);
    if (!mesh) return;
    const buffer = newUvBuffer ?? this.originalUvBuffers.get(role);
    if (!buffer) return;
    const geom = mesh.geometry;
    if (!(geom instanceof THREE.BufferGeometry)) return;
    geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(buffer), 2));
    geom.attributes.uv.needsUpdate = true;
  }

  getSubmeshUvData(role: string): SubmeshUvData | null {
    return this.submeshUvData.get(role) ?? null;
  }

  applyPbrTextures(role: string, maps: GeneratedMaps, tweak: PbrTweakParams = DEFAULT_PBR_TWEAK): void {
    const textures = createTextureSet(maps);
    this.disposeTextureSet(this.textures.get(role));
    this.textures.set(role, textures);
    for (const child of this.meshGroup.children) applyTexturesToGroup(child, role, textures, tweak);
    this.requestShadowUpdate();
  }

  /** Live-mutate the per-role MeshStandardMaterial scalar factors. Cheap;
   *  slider-drag rate. */
  applyPbrTweak(role: string, tweak: PbrTweakParams): void {
    for (const child of this.meshGroup.children) applyPbrTweakToGroup(child, role, tweak);
    this.requestShadowUpdate();
  }

  /**
   * Hot-path for live paint preview: rewrite the role's existing baseColor
   * texture pixels in-place. Avoids the GeneratedMaps allocation + shader
   * recompile that `applyPbrTextures` triggers each call. Call this from
   * pointer-move; call `applyPbrTextures` once on stroke end to settle
   * normal/ARM. If no baseColor texture is attached yet (very first paint
   * stroke before any Generate), we synthesize one from the rgba data.
   */
  updateBaseColor(role: string, rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): void {
    const data = new ImageData(rgba, w, h);
    const set = this.textures.get(role);
    if (set?.baseColor) {
      updateCanvasTexture(set.baseColor, data);
      this.requestShadowUpdate();
      return;
    }
    // First-touch: stand up a partial TextureSet so the mesh has a base
    // colour. Normal + ARM remain unset until the next applyPbrTextures.
    const baseColor = imageDataToCanvasTexture(data, true);
    const newSet: TextureSet = {
      baseColor,
      normal: set?.normal ?? imageDataToCanvasTexture(data, false),
      arm: set?.arm ?? imageDataToCanvasTexture(data, false),
    };
    this.disposeTextureSet(set);
    this.textures.set(role, newSet);
    for (const child of this.meshGroup.children) applyTexturesToGroup(child, role, newSet);
    this.requestShadowUpdate();
  }

  applyPreloadedTextureSet(role: string, textures: TextureSet): void {
    this.disposeTextureSet(this.textures.get(role));
    this.textures.set(role, textures);
    for (const child of this.meshGroup.children) applyTexturesToGroup(child, role, textures);
    this.requestShadowUpdate();
  }

  private disposeTextureSet(prev: TextureSet | undefined): void {
    if (!prev) return;
    prev.baseColor.dispose();
    prev.normal.dispose();
    prev.arm.dispose();
  }

  applyGlass(role: string, params: GlassParams): void {
    for (const child of this.meshGroup.children) applyGlassMaterial(child, role, params);
    this.requestShadowUpdate();
  }

  /**
   * Test-only: force-render N frames in synchronous succession. Used by the
   * Playwright suite to settle the iso preview before reading framebuffer
   * pixels — without this, the WebGL drawing buffer is wiped between tasks
   * and `readCanvasImageData` would return black.
   */
  forceFrame(n = 2): void {
    const now = performance.now();
    for (let i = 0; i < n; i++) {
      this.view.frame(now + i * 16, 0.016);
    }
  }

  /** Test-only: rotate the iso camera by N quarter-turns synchronously
   *  (skipping the rotation animation). Lets specs verify back / side
   *  face orientation by viewing from different yaws. */
  testRotateBy(quarterTurns: number): void {
    const sign = quarterTurns >= 0 ? 1 : -1;
    const n = Math.abs(quarterTurns);
    for (let i = 0; i < n; i++) this.view.rotateQuarterTurns(sign as -1 | 1);
    // Drain the rotation animation so subsequent forceFrame calls
    // see the final pose, not an interpolated mid-rotation state.
    for (let i = 0; i < 60; i++) this.view.frame(performance.now() + i * 32, 0.032);
  }

  /**
   * Test-only: render once and copy the resulting WebGL canvas into a 2D
   * context so callers can read pixels via `getImageData` after the fact.
   * The render + drawImage happens in one synchronous call so the drawing
   * buffer is still valid.
   */
  readCanvasImageData(): ImageData {
    const now = performance.now();
    this.view.frame(now, 0.016);
    const src = this.view.canvas;
    const tmp = document.createElement("canvas");
    tmp.width = src.width;
    tmp.height = src.height;
    const ctx = tmp.getContext("2d");
    if (!ctx) throw new Error("AuthoringScene.readCanvasImageData: 2D context unavailable");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, tmp.width, tmp.height);
  }

  private clearMesh(): void {
    while (this.meshGroup.children.length > 0) {
      const child = this.meshGroup.children[0];
      this.meshGroup.remove(child);
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose?.();
        }
      });
    }
    for (const [, tex] of this.textures) {
      tex.baseColor.dispose();
      tex.normal.dispose();
      tex.arm.dispose();
    }
    this.textures.clear();
    this.submeshUvData.clear();
    this.submeshMeshes.clear();
    this.originalUvBuffers.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animId);
    this.resizeObs.disconnect();
    this.unbindInput();
    this.clearMesh();
    this.view.dispose();
  }
}
