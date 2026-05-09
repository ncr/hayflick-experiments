import * as THREE from "three";
import { LevelRuntime, World } from "@common/gameplay";
import { createEcsLevelResourceFromBake, type LevelBuilderBake } from "./builder-bake";
import {
  createGreyboxMeshTemplate,
  disposeGreyboxMeshTemplate,
  findGreyboxDefinition
} from "./greybox";
import {
  bakeGreyboxLevelForEcs,
  type GreyboxLevelBakeInput,
  type GreyboxLevelPlacement
} from "./greybox-bake";

export type GreyboxRuntimeScene = {
  root: THREE.Group;
  runtime: LevelRuntime<THREE.Object3D>;
  bake: LevelBuilderBake;
  dispose: () => void;
};

function placementWorldPose(
  placement: GreyboxLevelPlacement,
  grid: GreyboxLevelBakeInput["grid"]
): { x: number; z: number; yaw: number } {
  if (placement.placement === "cell") {
    return {
      x: grid.origin + (placement.x + 0.5) * grid.tileSize,
      z: grid.origin + (placement.z + 0.5) * grid.tileSize,
      yaw: 0
    };
  }

  if (placement.placement === "vertex") {
    return {
      x: grid.origin + placement.x * grid.tileSize,
      z: grid.origin + placement.z * grid.tileSize,
      yaw: ((placement.rotation ?? 0) & 3) * (Math.PI * 0.5)
    };
  }

  const vertical = placement.ax === placement.bx;
  return {
    x: grid.origin + ((placement.ax + placement.bx) * 0.5) * grid.tileSize,
    z: grid.origin + ((placement.az + placement.bz) * 0.5) * grid.tileSize,
    yaw: (vertical ? Math.PI * 0.5 : 0) + (placement.flipped ? Math.PI : 0)
  };
}

function disposeObject3D(node: THREE.Object3D): void {
  if (node instanceof THREE.Group) {
    disposeGreyboxMeshTemplate(node);
    return;
  }

  node.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.dispose();
    }
  });
}

export function createGreyboxRuntimeScene(input: GreyboxLevelBakeInput): GreyboxRuntimeScene {
  const bake = bakeGreyboxLevelForEcs(input);
  const root = new THREE.Group();
  root.name = `greybox-runtime:${input.level.id}`;

  const runtime = new LevelRuntime<THREE.Object3D>({
    world: new World({ level: createEcsLevelResourceFromBake(bake) }),
    attach(node) {
      root.add(node);
    },
    detach(node) {
      root.remove(node);
    },
    disposeNode(node) {
      disposeObject3D(node);
    }
  });

  input.placements.forEach((placement, index) => {
    const definition = findGreyboxDefinition(placement.definitionId);
    if (!definition || definition.placement !== placement.placement) {
      return;
    }

    const pose = placementWorldPose(placement, input.grid);
    const node = createGreyboxMeshTemplate(
      definition,
      placement.placement === "edge" ? { state: placement.doorState } : {}
    );
    node.position.set(pose.x, 0, pose.z);
    node.rotation.y = pose.yaw;

    runtime.addObject({
      id: `greybox:${index}:${definition.id}`,
      node,
      transform: { x: pose.x, y: pose.z },
      persistent: { kind: definition.semantic.kind }
    });
  });

  return {
    root,
    runtime,
    bake,
    dispose() {
      runtime.dispose();
    }
  };
}
