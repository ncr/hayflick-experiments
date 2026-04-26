import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SharedScissorStage, PixelPerfectPane, TILESET_VIEWER_TARGET_CONFIG } from "@common/render";
import { bindPixelPerfectPaneBroadcast } from "@common/input";
import type { GeneratedMaps, GlassParams, Surface, SubmeshUvData } from "../types";
import { applyTexturesToGroup, createTextureSet, type TextureSet } from "../texture-swap";

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

function setLinearTextureFiltering(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
        mat.map.magFilter = THREE.LinearFilter;
        mat.map.minFilter = THREE.LinearFilter;
        mat.map.needsUpdate = true;
      }
    }
  });
}

type DiscoveryResult = {
  surfaces: Surface[];
  uvData: Map<string, SubmeshUvData>;
};

function discoverSurfaces(group: THREE.Object3D): DiscoveryResult {
  const byRole = new Map<string, Surface>();
  const uvData = new Map<string, SubmeshUvData>();
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
      if (data) uvData.set(role, data);
    }
  });
  return { surfaces: Array.from(byRole.values()), uvData };
}

function extractSubmeshUvData(mesh: THREE.Mesh, role: string): SubmeshUvData | null {
  const geom = mesh.geometry;
  if (!(geom instanceof THREE.BufferGeometry)) return null;
  const uvAttr = geom.attributes.uv;
  if (!uvAttr) return null;
  const vertexCount = uvAttr.count;
  // Use getX/getY so this works for both BufferAttribute and InterleavedBufferAttribute.
  const uvBuffer = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    uvBuffer[i * 2] = uvAttr.getX(i);
    uvBuffer[i * 2 + 1] = uvAttr.getY(i);
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
  return { indexBuffer, uvBuffer, vertexCount, materialName };
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
  private stage: SharedScissorStage;
  private pane: PixelPerfectPane;
  private unbindInput: () => void;
  private keyLight: THREE.DirectionalLight;
  private meshGroup = new THREE.Group();
  private textures = new Map<string, TextureSet>();
  private submeshUvData = new Map<string, SubmeshUvData>();
  private resizeObs: ResizeObserver;
  private animId = 0;
  private lastTime = performance.now();
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
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

    this.stage = new SharedScissorStage({
      mount: container,
      width,
      height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x0f1115,
      clearAlpha: 1,
      shadows: true,
    });
    this.stage.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.pane = new PixelPerfectPane({
      stage: this.stage,
      id: "matstudio-author",
      element: container,
      scene: this.scene,
      width,
      height,
      ...TILESET_VIEWER_TARGET_CONFIG,
      clearColor: 0x0f1115,
      toneMapping: "aces",
      shadows: true,
    });

    this.unbindInput = bindPixelPerfectPaneBroadcast({ stage: this.stage, panes: [this.pane] });

    this.resizeObs = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width: w, height: h } = e.contentRect;
        if (w > 0 && h > 0) this.stage.resize(w, h, Math.max(1, window.devicePixelRatio || 1));
      }
    });
    this.resizeObs.observe(container);

    const frame = (now: number) => {
      if (this.disposed) return;
      this.animId = requestAnimationFrame(frame);
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.stage.drawFrame(now, dt);
    };
    this.animId = requestAnimationFrame(frame);
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
    setLinearTextureFiltering(group);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.meshGroup.add(group);
    const { surfaces, uvData } = discoverSurfaces(group);
    this.submeshUvData = uvData;
    this.requestShadowUpdate();
    return surfaces;
  }

  getSubmeshUvData(role: string): SubmeshUvData | null {
    return this.submeshUvData.get(role) ?? null;
  }

  applyPbrTextures(role: string, maps: GeneratedMaps): void {
    const textures = createTextureSet(maps);
    this.disposeTextureSet(this.textures.get(role));
    this.textures.set(role, textures);
    for (const child of this.meshGroup.children) applyTexturesToGroup(child, role, textures);
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animId);
    this.resizeObs.disconnect();
    this.unbindInput();
    this.clearMesh();
    this.stage.dispose();
  }
}
