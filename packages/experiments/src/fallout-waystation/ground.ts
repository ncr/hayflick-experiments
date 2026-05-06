import * as THREE from "three";
import { PALETTE } from "./palette";
import { patchHeightFog } from "./fog";
import { patchAOFragment, aoGroundUniforms } from "./ao-patch";

// Composite ground built as one PlaneGeometry with vertex colors per region:
// grass everywhere, a road strip across the back, and a dirt path from the
// road to the building door. Vertex jitter adds tonal noise so big flat
// areas don't read as uniform.
//
// Coordinate system (world units = meters):
//   X: left/right, Z: depth (front=+Z, back=-Z), Y up.
//   Building footprint occupies roughly X in [-3, 3], Z in [-2, 2]; door at
//   Z ≈ +2. Road runs along Z ≈ +6 (in front of the building).

const GROUND_SIZE = 40;
const GROUND_SEGS = 200;
const ROAD_Z = 6.0;
const ROAD_HALF = 1.6;
const PATH_WIDTH = 1.0;
const DOOR_X = -1.0;
const BUILDING_FRONT_Z = 2.0;

function hash2(x: number, z: number): number {
  // Cheap deterministic noise, [0..1).
  let h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  h = h - Math.floor(h);
  return h;
}

function grassNoise(x: number, z: number): number {
  // Layered hash for blotchy grass tone variation.
  const a = hash2(Math.floor(x * 1.7), Math.floor(z * 1.7));
  const b = hash2(Math.floor(x * 0.6) + 13, Math.floor(z * 0.6) + 7);
  return 0.6 * a + 0.4 * b;
}

function isOnPath(x: number, z: number): boolean {
  // Path runs from (DOOR_X, BUILDING_FRONT_Z) to (DOOR_X+0.6, ROAD_Z), with
  // a subtle sinusoidal wobble so it doesn't read as a stamped rectangle.
  if (z < BUILDING_FRONT_Z - 0.1 || z > ROAD_Z + 0.2) return false;
  const t = (z - BUILDING_FRONT_Z) / (ROAD_Z - BUILDING_FRONT_Z);
  const wobble = Math.sin(t * Math.PI * 2.2) * 0.35;
  const centerX = DOOR_X + t * 0.6 + wobble;
  return Math.abs(x - centerX) < PATH_WIDTH * 0.5;
}

function isOnRoad(z: number): boolean {
  return Math.abs(z - ROAD_Z) < ROAD_HALF;
}

function isOnRoadStripe(x: number, z: number): boolean {
  if (Math.abs(z - ROAD_Z) > 0.06) return false;
  // Dashed centerline; ~1m dash, ~1m gap.
  const m = ((x % 2) + 2) % 2;
  return m < 1.0;
}

function isOnRoadCrack(x: number, z: number): boolean {
  // Sparse cracks. We probe a low-frequency hash for "is this a crack cell"
  // and a finer hash for "is this fragment on the crack line."
  if (Math.abs(z - ROAD_Z) > ROAD_HALF - 0.1) return false;
  const cellX = Math.floor(x * 0.4);
  const cellZ = Math.floor(z * 0.4);
  if (hash2(cellX * 7, cellZ * 11) < 0.85) return false;
  return hash2(x * 9.1, z * 9.1) < 0.18;
}

export function createGround(): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(
    GROUND_SIZE,
    GROUND_SIZE,
    GROUND_SEGS,
    GROUND_SEGS
  );
  geom.rotateX(-Math.PI / 2);

  const positions = geom.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const c = new THREE.Color();
  const grass = new THREE.Color(PALETTE.grass);
  const grassDark = new THREE.Color(PALETTE.grassDark);
  const dirt = new THREE.Color(PALETTE.dirt);
  const dirtDark = new THREE.Color(PALETTE.dirtDark);
  const road = new THREE.Color(PALETTE.road);
  const roadStripe = new THREE.Color(PALETTE.roadStripe);
  const roadCrack = new THREE.Color(PALETTE.roadCrack);

  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);

    if (isOnRoad(z)) {
      if (isOnRoadStripe(x, z)) c.copy(roadStripe);
      else if (isOnRoadCrack(x, z)) c.copy(roadCrack);
      else c.copy(road);
      // tiny jitter on road
      const j = (hash2(x * 3, z * 3) - 0.5) * 0.04;
      c.r = Math.max(0, c.r + j);
      c.g = Math.max(0, c.g + j);
      c.b = Math.max(0, c.b + j);
    } else if (isOnPath(x, z)) {
      const t = grassNoise(x, z);
      c.copy(dirtDark).lerp(dirt, t);
    } else {
      const t = grassNoise(x, z);
      c.copy(grassDark).lerp(grass, t);
      // sparse darker grass clumps
      if (hash2(Math.floor(x * 1.3), Math.floor(z * 1.3)) > 0.92) {
        c.multiplyScalar(0.78);
      }
    }

    // Wall-contact AO is applied per-fragment by `ao-patch`, not baked.
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: false
  });
  patchHeightFog(mat);
  patchAOFragment(mat, { wallUniforms: aoGroundUniforms });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  mesh.position.y = -0.001;
  mesh.name = "ground";
  return mesh;
}
