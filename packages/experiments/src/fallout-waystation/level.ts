import * as THREE from "three";
import { LevelRuntime, type System } from "@common/gameplay";

export type WaystationLevel = {
  runtime: LevelRuntime<THREE.Object3D>;
  add(id: string, node: THREE.Object3D): void;
  system(system: System): void;
  step(dt: number): void;
  dispose(): void;
};

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose();
    }
    return;
  }

  material.dispose();
}

function disposeObject(node: THREE.Object3D): void {
  node.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

export function createWaystationLevel(scene: THREE.Scene): WaystationLevel {
  const runtime = new LevelRuntime<THREE.Object3D>({
    attach(node) {
      scene.add(node);
    },
    detach(node) {
      scene.remove(node);
    },
    disposeNode: disposeObject
  });

  return {
    runtime,
    add(id, node) {
      runtime.addObject({ id, node });
    },
    system(system) {
      runtime.addSystem(system);
    },
    step(dt) {
      runtime.step(dt);
    },
    dispose() {
      runtime.dispose();
    }
  };
}
