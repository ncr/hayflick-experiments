import * as THREE from "three";
import { PALETTE } from "./palette";
import { createTintedBox, type FaceTint } from "./box";
import { patchHeightFog } from "./fog";
import { patchAOFragment, aoFloorUniforms } from "./ao-patch";

// Iso cutaway trick: walls and roof on the camera-side are placed on
// `INVISIBLE_LAYER` so the main camera (layer 0) never renders them, but the
// sun has layers 0+1 enabled so they still cast shadows. The interior floor
// becomes a canvas for window-shaped sunlit pools and the roof-hole god-ray
// cone — automatic, courtesy of shadow mapping.

export const INVISIBLE_LAYER = 1;

const WALL_THICKNESS = 0.18;
const WALL_HEIGHT = 2.6;
const INTERIOR_VISIBLE_HEIGHT = 0.95;
const CUTAWAY_VISIBLE_HEIGHT = 0.55;

// Building footprint: X ∈ [-3, +3], Z ∈ [-2, +2].
// Layout:
//   Room A (entrance hall): X ∈ [-3, +1], Z ∈ [ 0, +2].
//   Room B (bunkroom):       X ∈ [-3, +1], Z ∈ [-2,  0].
//   Room C (broken back):    X ∈ [+1, +3], Z ∈ [-2, +2]. Roof collapsed here.
const BX_MIN = -3;
const BX_MAX = 3;
const BZ_MIN = -2;
const BZ_MAX = 2;

type Opening = { at: number; width: number; bottom: number; top: number };

export type BuildingHandles = {
  group: THREE.Group;
  windowGlows: THREE.Mesh[];
  windowSpecs: Array<{
    /** Center of window in world coordinates (inside opening). */
    center: THREE.Vector3;
    /** Window width along the wall. */
    width: number;
    /** Outward-facing normal (unit vector). */
    normal: THREE.Vector3;
    /** Vector along the wall (unit, perpendicular to normal). */
    along: THREE.Vector3;
    /** Whether this window faces outdoors (i.e. is in an exterior wall). */
    exterior: boolean;
  }>;
  roofHoleCenter: THREE.Vector3;
  roofHoleSize: { width: number; depth: number };
};

/**
 * Decomposes a wall slice (length × height) into sub-rectangles around
 * openings. Each opening is in slice-local coordinates: `at` along the wall,
 * `width` along the wall, `bottom` and `top` in the slice's vertical range
 * [0, height].
 */
function decompose(
  length: number,
  height: number,
  openings: Opening[]
): Array<{ along: number; up: number; alongLen: number; height: number }> {
  const sorted = openings.slice().sort((a, b) => a.at - b.at);
  const segs: Array<{
    along: number;
    up: number;
    alongLen: number;
    height: number;
  }> = [];
  let cursor = 0;
  for (const op of sorted) {
    if (op.at > cursor) {
      segs.push({
        along: cursor,
        up: 0,
        alongLen: op.at - cursor,
        height
      });
    }
    if (op.bottom > 0) {
      segs.push({
        along: op.at,
        up: 0,
        alongLen: op.width,
        height: op.bottom
      });
    }
    if (op.top < height) {
      segs.push({
        along: op.at,
        up: op.top,
        alongLen: op.width,
        height: height - op.top
      });
    }
    cursor = op.at + op.width;
  }
  if (cursor < length) {
    segs.push({
      along: cursor,
      up: 0,
      alongLen: length - cursor,
      height
    });
  }
  return segs;
}

function buildWallSlice(opts: {
  start: THREE.Vector2;
  end: THREE.Vector2;
  yBase: number;
  yTop: number;
  thickness: number;
  baseColor: number;
  parent: THREE.Object3D;
  layer?: number;
  openings?: Opening[];
  tint?: FaceTint;
  noiseSeed?: number;
}): void {
  const dx = opts.end.x - opts.start.x;
  const dz = opts.end.y - opts.start.y;
  const length = Math.hypot(dx, dz);
  if (length < 1e-4) return;
  const angle = Math.atan2(dz, dx);
  const sliceHeight = opts.yTop - opts.yBase;

  const localOpenings: Opening[] = [];
  for (const op of opts.openings ?? []) {
    const b = Math.max(0, op.bottom - opts.yBase);
    const t = Math.min(sliceHeight, op.top - opts.yBase);
    if (t > b + 1e-3) {
      localOpenings.push({ at: op.at, width: op.width, bottom: b, top: t });
    }
  }

  const segments = decompose(length, sliceHeight, localOpenings);

  let segIndex = 0;
  for (const seg of segments) {
    const box = createTintedBox(
      { x: seg.alongLen, y: seg.height, z: opts.thickness },
      opts.baseColor,
      {
        tint: {
          ...opts.tint,
          noiseAmount: opts.tint?.noiseAmount ?? 0.025,
          noiseSeed: (opts.noiseSeed ?? 0) + segIndex
        }
      }
    );
    const localCenterAlong = seg.along + seg.alongLen / 2;
    const t = localCenterAlong / length;
    const cx = opts.start.x + dx * t;
    const cz = opts.start.y + dz * t;
    const cy = opts.yBase + seg.up + seg.height / 2;
    box.position.set(cx, cy, cz);
    box.rotation.y = -angle;
    if (opts.layer !== undefined && opts.layer !== 0) {
      box.layers.set(opts.layer);
      box.traverse((o) => o.layers.set(opts.layer!));
    }
    box.castShadow = true;
    box.receiveShadow = opts.layer === undefined || opts.layer === 0;
    opts.parent.add(box);
    segIndex++;
  }
}

function buildSplitInteriorWall(opts: {
  start: THREE.Vector2;
  end: THREE.Vector2;
  thickness: number;
  baseColor: number;
  parent: THREE.Object3D;
  openings?: Opening[];
  noiseSeed?: number;
}): void {
  // Visible bottom slice — what the player reads as "the wall."
  buildWallSlice({
    ...opts,
    yBase: 0,
    yTop: INTERIOR_VISIBLE_HEIGHT,
    layer: 0
  });
  // Invisible top slice — completes the wall for shadow purposes without
  // occluding the iso camera.
  buildWallSlice({
    ...opts,
    yBase: INTERIOR_VISIBLE_HEIGHT,
    yTop: WALL_HEIGHT,
    layer: INVISIBLE_LAYER,
    noiseSeed: (opts.noiseSeed ?? 0) + 100
  });
}

function buildSplitCutawayWall(opts: {
  start: THREE.Vector2;
  end: THREE.Vector2;
  thickness: number;
  baseColor: number;
  parent: THREE.Object3D;
  openings?: Opening[];
  noiseSeed?: number;
}): void {
  // Camera-near exterior wall: low fascia visible (0..CUTAWAY_VISIBLE_HEIGHT)
  // so the building footprint reads from outside, with the rest invisible
  // for shadow casting only. Without this the camera-side of the building
  // looks like a cardboard cut-out without anchor.
  buildWallSlice({
    ...opts,
    yBase: 0,
    yTop: CUTAWAY_VISIBLE_HEIGHT,
    layer: 0
  });
  buildWallSlice({
    ...opts,
    yBase: CUTAWAY_VISIBLE_HEIGHT,
    yTop: WALL_HEIGHT,
    layer: INVISIBLE_LAYER,
    noiseSeed: (opts.noiseSeed ?? 0) + 200
  });
}

function buildFloor(parent: THREE.Object3D): void {
  // Wood floor inside building footprint. Sits 1 mm above ground to avoid
  // z-fighting; receives shadows from walls and roof.
  const w = BX_MAX - BX_MIN;
  const d = BZ_MAX - BZ_MIN;
  const segs = 30;
  const geom = new THREE.PlaneGeometry(w, d, segs, segs);
  geom.rotateX(-Math.PI / 2);
  const positions = geom.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const base = new THREE.Color(PALETTE.floor);
  const dark = new THREE.Color(PALETTE.floor).multiplyScalar(0.72);
  const c = new THREE.Color();
  // Floor mesh sits at world (0, 0); local x/z map directly to world x/z.
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const planks = Math.abs(Math.sin(z * 6.0));
    c.copy(base).lerp(dark, planks * 0.4);
    const j =
      (Math.sin(x * 17.3 + z * 11.1) * 0.5 + 0.5 - 0.5) * 0.04;
    c.r = Math.max(0, c.r + j);
    c.g = Math.max(0, c.g + j);
    c.b = Math.max(0, c.b + j);
    // Wall-contact AO applied per-fragment via `ao-patch`.
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0
  });
  patchHeightFog(mat);
  patchAOFragment(mat, { wallUniforms: aoFloorUniforms });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((BX_MIN + BX_MAX) / 2, 0.001, (BZ_MIN + BZ_MAX) / 2);
  mesh.receiveShadow = true;
  mesh.name = "building-floor";
  parent.add(mesh);
}

function buildRoof(parent: THREE.Object3D): {
  holeCenter: THREE.Vector3;
  holeSize: { width: number; depth: number };
} {
  // Single flat roof slab over Rooms A + B (X ∈ [-3, +1], Z ∈ [-2, +2]).
  // Room C (X > +1) is open to the sky → its floor catches the dramatic
  // shaft of sunlight. Roof is on INVISIBLE_LAYER so the camera doesn't see
  // it; the sun has layer 1 enabled, so it casts shadow normally.
  const xMin = BX_MIN;
  const xMax = 1;
  const zMin = BZ_MIN;
  const zMax = BZ_MAX;
  const width = xMax - xMin;
  const depth = zMax - zMin;
  const thickness = 0.12;
  const slab = createTintedBox(
    { x: width, y: thickness, z: depth },
    PALETTE.roof
  );
  slab.position.set(
    (xMin + xMax) / 2,
    WALL_HEIGHT + thickness / 2,
    (zMin + zMax) / 2
  );
  slab.layers.set(INVISIBLE_LAYER);
  slab.traverse((o) => o.layers.set(INVISIBLE_LAYER));
  slab.castShadow = true;
  slab.receiveShadow = false;
  slab.name = "roof-slab";
  parent.add(slab);

  // Roof hole center is over Room C, but the hole is implicit (Room C has
  // no roof slab). Return a representative position for the light-shaft
  // module to anchor a visual god-ray quad.
  return {
    holeCenter: new THREE.Vector3(2.0, WALL_HEIGHT + thickness / 2, 0.0),
    holeSize: { width: 2.0, depth: 4.0 }
  };
}

export function createBuilding(): BuildingHandles {
  const group = new THREE.Group();
  group.name = "building";

  buildFloor(group);

  const windowSpecs: BuildingHandles["windowSpecs"] = [];

  // ── Exterior walls ────────────────────────────────────────────────

  // West (-X) exterior wall. Visible. Window for Room B at Z ≈ -1.
  buildWallSlice({
    start: new THREE.Vector2(BX_MIN, BZ_MIN),
    end: new THREE.Vector2(BX_MIN, BZ_MAX),
    yBase: 0,
    yTop: WALL_HEIGHT,
    thickness: WALL_THICKNESS,
    baseColor: PALETTE.wallExterior,
    parent: group,
    layer: 0,
    openings: [{ at: 0.5, width: 1.0, bottom: 1.0, top: 2.0 }],
    noiseSeed: 1
  });
  windowSpecs.push({
    center: new THREE.Vector3(BX_MIN + WALL_THICKNESS / 2, 1.5, BZ_MIN + 1.0),
    width: 1.0,
    normal: new THREE.Vector3(-1, 0, 0),
    along: new THREE.Vector3(0, 0, 1),
    exterior: true
  });

  // North (-Z) exterior back wall. Visible portion behind A & B (X in [-3,
  // +1]). Then a low rubble line behind Room C (X in [+1, +3]) for the
  // collapsed look.
  buildWallSlice({
    start: new THREE.Vector2(BX_MIN, BZ_MIN),
    end: new THREE.Vector2(1, BZ_MIN),
    yBase: 0,
    yTop: WALL_HEIGHT,
    thickness: WALL_THICKNESS,
    baseColor: PALETTE.wallExterior,
    parent: group,
    layer: 0,
    openings: [{ at: 1.5, width: 1.0, bottom: 1.0, top: 2.0 }],
    noiseSeed: 2
  });
  windowSpecs.push({
    center: new THREE.Vector3(-1.0, 1.5, BZ_MIN + WALL_THICKNESS / 2),
    width: 1.0,
    normal: new THREE.Vector3(0, 0, -1),
    along: new THREE.Vector3(1, 0, 0),
    exterior: true
  });
  // Collapsed rubble line behind Room C — short, broken-color box.
  const rubble = createTintedBox(
    { x: 2.0, y: 0.6, z: WALL_THICKNESS },
    PALETTE.wallBroken,
    { tint: { noiseAmount: 0.06, noiseSeed: 99 } }
  );
  rubble.position.set(2.0, 0.3, BZ_MIN);
  rubble.rotation.y = 0.04;
  rubble.castShadow = true;
  rubble.receiveShadow = true;
  group.add(rubble);

  // East (+X) exterior wall — split: low fascia visible, upper invisible
  // shadow caster. Window for Room C at Z ≈ 0 lets sun pour in from the
  // east.
  buildSplitCutawayWall({
    start: new THREE.Vector2(BX_MAX, BZ_MIN),
    end: new THREE.Vector2(BX_MAX, BZ_MAX),
    thickness: WALL_THICKNESS,
    baseColor: PALETTE.wallExterior,
    parent: group,
    openings: [{ at: 1.5, width: 1.2, bottom: 1.0, top: 2.0 }],
    noiseSeed: 3
  });
  windowSpecs.push({
    center: new THREE.Vector3(BX_MAX - WALL_THICKNESS / 2, 1.5, -0.4),
    width: 1.2,
    normal: new THREE.Vector3(1, 0, 0),
    along: new THREE.Vector3(0, 0, 1),
    exterior: true
  });

  // South (+Z) exterior front wall — split: low fascia visible, upper
  // invisible shadow caster. Door at X ≈ -1 (full height), Room A window
  // at X ≈ +0.5, Room C window at X ≈ +2.
  buildSplitCutawayWall({
    start: new THREE.Vector2(BX_MIN, BZ_MAX),
    end: new THREE.Vector2(BX_MAX, BZ_MAX),
    thickness: WALL_THICKNESS,
    baseColor: PALETTE.wallExterior,
    parent: group,
    openings: [
      { at: 1.5, width: 1.0, bottom: 0.0, top: 2.2 }, // door
      { at: 3.2, width: 0.8, bottom: 1.0, top: 2.0 }, // Room A window
      { at: 4.5, width: 1.0, bottom: 1.0, top: 2.0 } // Room C window
    ],
    noiseSeed: 4
  });
  windowSpecs.push({
    center: new THREE.Vector3(0.1, 1.5, BZ_MAX - WALL_THICKNESS / 2),
    width: 0.8,
    normal: new THREE.Vector3(0, 0, 1),
    along: new THREE.Vector3(1, 0, 0),
    exterior: true
  });
  windowSpecs.push({
    center: new THREE.Vector3(2.0, 1.5, BZ_MAX - WALL_THICKNESS / 2),
    width: 1.0,
    normal: new THREE.Vector3(0, 0, 1),
    along: new THREE.Vector3(1, 0, 0),
    exterior: true
  });

  // ── Interior walls (split visible + invisible) ────────────────────

  // Z=0 wall between Room A (south) and Room B (north). Doorway at X ≈ -1.
  buildSplitInteriorWall({
    start: new THREE.Vector2(BX_MIN, 0),
    end: new THREE.Vector2(1, 0),
    thickness: WALL_THICKNESS,
    baseColor: PALETTE.wallInterior,
    parent: group,
    openings: [{ at: 1.5, width: 1.0, bottom: 0.0, top: 2.1 }],
    noiseSeed: 5
  });

  // X=+1 wall between Rooms A,B and Room C. Doorway at Z ≈ +0.7 connecting
  // Room A to Room C.
  buildSplitInteriorWall({
    start: new THREE.Vector2(1, BZ_MIN),
    end: new THREE.Vector2(1, BZ_MAX),
    thickness: WALL_THICKNESS,
    baseColor: PALETTE.wallInterior,
    parent: group,
    openings: [{ at: 2.4, width: 1.0, bottom: 0.0, top: 2.1 }],
    noiseSeed: 6
  });

  // ── Roof ──────────────────────────────────────────────────────────
  const roofHole = buildRoof(group);

  // Fallen-roof beam in Room C — visible decoration that says "this used
  // to be a roof."
  const beam = createTintedBox(
    { x: 2.4, y: 0.18, z: 0.16 },
    PALETTE.roofRib,
    { tint: { noiseAmount: 0.04, noiseSeed: 88 } }
  );
  beam.position.set(2.0, 0.4, 1.0);
  beam.rotation.set(0.18, 0.35, 0.05);
  beam.castShadow = true;
  beam.receiveShadow = true;
  group.add(beam);

  // ── Window glow placeholders (invisible by default; lit by GUI) ───
  // For each exterior window facing outdoors, add a thin emissive plane
  // inside the opening so we can dial in interior-warm-glow at dusk.
  const windowGlows: THREE.Mesh[] = [];
  for (const spec of windowSpecs) {
    const geom = new THREE.PlaneGeometry(spec.width, 1.0);
    const mat = new THREE.MeshBasicMaterial({
      color: PALETTE.glassWarm,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(spec.center);
    // Orient plane normal opposite to the wall outward direction.
    const lookTarget = spec.center.clone().add(spec.normal);
    mesh.lookAt(lookTarget);
    mesh.name = "window-glow";
    group.add(mesh);
    windowGlows.push(mesh);
  }

  return {
    group,
    windowGlows,
    windowSpecs,
    roofHoleCenter: roofHole.holeCenter,
    roofHoleSize: roofHole.holeSize
  };
}
