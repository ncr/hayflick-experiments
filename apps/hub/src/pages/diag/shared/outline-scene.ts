import * as THREE from "three";

export type OutlineTestScene = {
  scene: THREE.Scene;
  wallLeft: THREE.Mesh;
  wallRight: THREE.Mesh;
  wallFar: THREE.Mesh;
  floor: THREE.Mesh;
};

/**
 * Outline-testing geometry: a floor + three walls arranged so both adjacent
 * (coplanar-abutting) and separated configurations are reachable by the
 * debug scenes. Uses `MeshStandardMaterial` + ambient light so the normal
 * pass reads usable surface normals.
 */
export function buildOutlineScene(): OutlineTestScene {
  const scene = new THREE.Scene();

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(3, 5, 2);
  scene.add(key);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const wallMaterial = (color: number) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 });

  const wallLeft = new THREE.Mesh(new THREE.BoxGeometry(1.28, 2.56, 0.32), wallMaterial(0xb55555));
  wallLeft.position.set(-0.64, 1.28, 0);
  scene.add(wallLeft);

  const wallRight = new THREE.Mesh(new THREE.BoxGeometry(1.28, 2.56, 0.32), wallMaterial(0xb55555));
  wallRight.position.set(0.64, 1.28, 0);
  scene.add(wallRight);

  const wallFar = new THREE.Mesh(new THREE.BoxGeometry(1.28, 2.56, 0.32), wallMaterial(0x55b5b5));
  wallFar.position.set(0, 1.28, 1.6);
  scene.add(wallFar);

  return { scene, wallLeft, wallRight, wallFar, floor };
}
