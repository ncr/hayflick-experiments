import * as THREE from "three";

/**
 * Fixed-geometry scene used by the alignment / pan / zoom / rotation diag
 * routes. Uses `MeshBasicMaterial` so the output is independent of lighting:
 * every pixel is either the flat material color or the clear color — any
 * cross-run difference points at the renderer, not scene state.
 *
 * Positions are in world meters (1 tile = 1.28 m).
 */
export function buildAlignmentScene(): THREE.Scene {
  const scene = new THREE.Scene();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshBasicMaterial({ color: 0x2a3340 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);

  const grid = new THREE.GridHelper(8, 8, 0x4a5566, 0x303a48);
  (grid.material as THREE.Material).transparent = false;
  grid.position.y = 0.002;
  scene.add(grid);

  const blocks: Array<{ color: number; pos: [number, number, number]; size: number }> = [
    { color: 0xd63a3a, pos: [0, 0.64, 0], size: 1.28 },
    { color: 0x3ad63a, pos: [-1.92, 0.32, 0], size: 0.64 },
    { color: 0x3a3ad6, pos: [0, 0.32, -1.92], size: 0.64 },
    { color: 0xd6d63a, pos: [1.92, 0.32, 0], size: 0.64 },
    { color: 0xd63ad6, pos: [0, 0.32, 1.92], size: 0.64 }
  ];

  for (const { color, pos, size } of blocks) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshBasicMaterial({ color })
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    scene.add(mesh);
  }

  return scene;
}
