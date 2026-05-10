import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const SIZE = 256;
const BASE_MESH_MATERIAL_COLOR = 0xb8bfc8;

type GlbKind = "base" | "entry";

type QueueItem = {
  key: string;
  kind: GlbKind;
  url: string;
  resolve: (dataUrl: string) => void;
  reject: (err: Error) => void;
};

const loader = new GLTFLoader();

class ThumbnailRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private cache = new Map<string, string>();
  private queue: QueueItem[] = [];
  private running = false;
  private disposed = false;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setSize(SIZE, SIZE, false);
    this.renderer.setClearColor(0x0f1115, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x3a2f22, 0.9));
    const key = new THREE.DirectionalLight(0xfff1d6, 2.4);
    key.position.set(6, 10, 8);
    this.scene.add(key);

    const aspect = 1;
    const frustum = 1;
    this.camera = new THREE.OrthographicCamera(
      -frustum * aspect,
      frustum * aspect,
      frustum,
      -frustum,
      0.1,
      200
    );
    const pitch = Math.atan(0.5);
    const yaw = Math.PI / 4;
    const dist = 40;
    this.camera.position.set(
      Math.cos(pitch) * Math.sin(yaw) * dist,
      Math.sin(pitch) * dist,
      Math.cos(pitch) * Math.cos(yaw) * dist
    );
    this.camera.lookAt(0, 0, 0);
  }

  cached(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  async get(key: string, kind: GlbKind, url: string): Promise<string> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      this.queue.push({ key, kind, url, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift()!;
        try {
          const cached = this.cache.get(job.key);
          if (cached) {
            job.resolve(cached);
            continue;
          }
          const dataUrl = await this.render(job.kind, job.url);
          this.cache.set(job.key, dataUrl);
          job.resolve(dataUrl);
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async render(kind: GlbKind, url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(buffer, "", resolve, reject);
    });
    const group = gltf.scene;

    if (kind === "base") {
      overrideWithNeutralMaterial(group);
    }

    const holder = new THREE.Group();
    holder.add(group);
    this.scene.add(holder);

    // Centre and scale to fit
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.5 / maxDim;
    holder.scale.setScalar(scale);
    holder.position.set(-centre.x * scale, -centre.y * scale + 0.02, -centre.z * scale);

    try {
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL("image/png");
    } finally {
      this.scene.remove(holder);
      disposeGroup(group);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.queue) job.reject(new Error("Thumbnail renderer disposed"));
    this.queue = [];
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function overrideWithNeutralMaterial(group: THREE.Object3D): void {
  const shared = new THREE.MeshStandardMaterial({
    color: BASE_MESH_MATERIAL_COLOR,
    roughness: 0.85,
    metalness: 0,
  });
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.material = shared;
  });
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) (m as THREE.Material | undefined)?.dispose?.();
    }
  });
}

let instance: ThumbnailRenderer | null = null;

export function getThumbnailRenderer(): ThumbnailRenderer {
  if (!instance) instance = new ThumbnailRenderer();
  return instance;
}

export function disposeThumbnailRenderer(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}

export function baseMeshKey(id: string): string {
  return `base:${id}`;
}

export function entryKey(name: string, version: string | null): string {
  return `entry:${name}:${version ?? "initial"}`;
}

export function baseMeshUrl(id: string): string {
  return `/api/assets/read?path=${encodeURIComponent(`meshes/${id}.glb`)}`;
}

export function entryUrl(name: string): string {
  return `/api/assets/read?path=${encodeURIComponent(`textured-meshes/${name}/artifact.glb`)}`;
}
