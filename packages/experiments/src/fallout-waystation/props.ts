import * as THREE from "three";
import { PALETTE } from "./palette";
import { createTintedBox } from "./box";

// Decorative props that give the scene scale and life. Each function
// returns a Group containing the prop's meshes (and any owned lights). The
// `lamp` exposes its emissive material so the GUI can flicker it.

export type LampHandle = {
  group: THREE.Group;
  bulbMaterial: THREE.MeshStandardMaterial;
  bulbLight: THREE.PointLight;
  baseEmissive: number;
};

export function createLampPost(): LampHandle {
  const group = new THREE.Group();
  group.name = "lamp-post";

  const post = createTintedBox(
    { x: 0.12, y: 3.2, z: 0.12 },
    PALETTE.metalDull,
    { tint: { noiseAmount: 0.03 } }
  );
  post.position.y = 1.6;
  // Lean it slightly — wasteland leans count.
  post.rotation.z = 0.06;
  group.add(post);

  const arm = createTintedBox(
    { x: 0.6, y: 0.08, z: 0.08 },
    PALETTE.metalDull
  );
  arm.position.set(0.3, 3.0, 0);
  arm.rotation.z = 0.06;
  group.add(arm);

  const fixture = createTintedBox(
    { x: 0.16, y: 0.18, z: 0.16 },
    PALETTE.metalRust,
    { tint: { noiseAmount: 0.04 } }
  );
  fixture.position.set(0.55, 2.85, 0);
  group.add(fixture);

  // Bulb: emissive sphere. Manage emissive intensity via flicker.
  const bulbGeom = new THREE.SphereGeometry(0.08, 8, 6);
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x402a18,
    emissive: PALETTE.lampLight,
    emissiveIntensity: 1.6,
    roughness: 1,
    metalness: 0,
    fog: false
  });
  const bulb = new THREE.Mesh(bulbGeom, bulbMat);
  bulb.position.set(0.55, 2.78, 0);
  bulb.castShadow = false;
  group.add(bulb);

  // Tiny point light at the bulb so nearby surfaces actually pick up the
  // warm glow at night.
  const light = new THREE.PointLight(PALETTE.lampLight, 1.4, 5.0, 1.6);
  light.position.copy(bulb.position);
  light.castShadow = false;
  group.add(light);

  return {
    group,
    bulbMaterial: bulbMat,
    bulbLight: light,
    baseEmissive: 1.6
  };
}

export function createChimney(): THREE.Group {
  // Brick-stack chimney sitting on the front-left roof corner.
  const group = new THREE.Group();
  group.name = "chimney";
  const stack = createTintedBox(
    { x: 0.5, y: 1.2, z: 0.5 },
    PALETTE.metalRust,
    { tint: { noiseAmount: 0.06, noiseSeed: 17 } }
  );
  stack.position.y = 0.6;
  group.add(stack);
  const cap = createTintedBox(
    { x: 0.6, y: 0.08, z: 0.6 },
    PALETTE.metalDull
  );
  cap.position.y = 1.24;
  group.add(cap);
  // Position over Room A's roof.
  group.position.set(-2.2, 2.8, -0.2);
  return group;
}

export function createBrokenPipe(): THREE.Group {
  const group = new THREE.Group();
  group.name = "broken-pipe";
  const horizontal = createTintedBox(
    { x: 0.16, y: 0.16, z: 0.6 },
    PALETTE.metalRust,
    { tint: { noiseAmount: 0.05 } }
  );
  horizontal.position.set(0, 0, 0);
  group.add(horizontal);
  const elbow = createTintedBox(
    { x: 0.18, y: 0.18, z: 0.18 },
    PALETTE.metalRust
  );
  elbow.position.set(0, 0, 0.34);
  group.add(elbow);
  const vertical = createTintedBox(
    { x: 0.16, y: 0.5, z: 0.16 },
    PALETTE.metalRust,
    { tint: { noiseAmount: 0.05, noiseSeed: 5 } }
  );
  vertical.position.set(0, -0.25, 0.34);
  group.add(vertical);
  // Pokes out of the west wall around Room B at Z=-0.5.
  group.position.set(-3.05, 1.4, -0.5);
  return group;
}

export function createCrates(): THREE.Group {
  const group = new THREE.Group();
  group.name = "crates";

  const c1 = createTintedBox({ x: 0.7, y: 0.7, z: 0.7 }, PALETTE.wood, {
    tint: { noiseAmount: 0.05, noiseSeed: 11 }
  });
  c1.position.set(-2.4, 0.36, -1.4);
  c1.rotation.y = 0.18;
  group.add(c1);

  const c2 = createTintedBox({ x: 0.55, y: 0.55, z: 0.55 }, PALETTE.wood, {
    tint: { noiseAmount: 0.05, noiseSeed: 22 }
  });
  c2.position.set(-2.0, 0.28, -1.7);
  c2.rotation.y = -0.4;
  group.add(c2);

  const c3 = createTintedBox({ x: 0.6, y: 0.4, z: 0.45 }, PALETTE.metalDull, {
    tint: { noiseAmount: 0.04, noiseSeed: 33 }
  });
  c3.position.set(2.4, 0.21, 1.4);
  c3.rotation.y = 0.6;
  group.add(c3);

  // Mattress-shape in Room B as a bunkroom hint.
  const bunk = createTintedBox(
    { x: 1.6, y: 0.18, z: 0.7 },
    PALETTE.fabric,
    { tint: { noiseAmount: 0.04 } }
  );
  bunk.position.set(-2.0, 0.1, -1.0);
  group.add(bunk);

  return group;
}

export function createBuildingDoor(): THREE.Mesh {
  // The door itself sits ajar in the front opening.
  const door = createTintedBox(
    { x: 0.85, y: 2.0, z: 0.05 },
    PALETTE.wood,
    { tint: { noiseAmount: 0.05, noiseSeed: 7 } }
  );
  door.position.set(-0.6, 1.0, 1.95);
  door.rotation.y = -0.7;
  return door;
}

/**
 * Compose all decorative props into one scene group.
 */
export function createProps(): {
  group: THREE.Group;
  lamp: LampHandle;
} {
  const group = new THREE.Group();
  group.name = "props";

  const lamp = createLampPost();
  lamp.group.position.set(-1.8, 0, 5.6);
  group.add(lamp.group);

  group.add(createChimney());
  group.add(createBrokenPipe());
  group.add(createCrates());
  group.add(createBuildingDoor());

  return { group, lamp };
}
