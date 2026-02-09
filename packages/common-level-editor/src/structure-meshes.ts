import * as THREE from "three";
import {
  LEVEL_EDITOR_PIXELS_PER_UNIT_X,
  LEVEL_EDITOR_PIXELS_PER_UNIT_Y,
  LEVEL_EDITOR_WORLD_UNIT
} from "./constants";

export type EditorStructureDoorState = "open" | "closed";

export type EditorDoorVisual = {
  root: THREE.Group;
  leafPivot: THREE.Group;
};

export type EditorStructureSegmentOptions = {
  trimStart?: boolean;
  trimEnd?: boolean;
  trimStartAmount?: number;
  trimEndAmount?: number;
};

type EditorStructureMaterials = {
  wall: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  windowGlass: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
};

type EditorStructureGeometries = {
  wallCore: THREE.BoxGeometry;
  windowLower: THREE.BoxGeometry;
  windowUpper: THREE.BoxGeometry;
  windowGlass: THREE.PlaneGeometry;
  doorLeaf: THREE.BoxGeometry;
  nodeCore: THREE.BoxGeometry;
  joinCorner: THREE.BufferGeometry;
  joinTee: THREE.BufferGeometry;
  joinCross: THREE.BufferGeometry;
};

export type EditorStructureMeshKit = {
  createWallSegment: (options?: EditorStructureSegmentOptions) => THREE.Group;
  createWallBlock: () => THREE.Group;
  createWindowSegment: (options?: EditorStructureSegmentOptions) => THREE.Group;
  createDoorVisual: () => EditorDoorVisual;
  createDoorSegment: (
    state: EditorStructureDoorState,
    options?: EditorStructureSegmentOptions
  ) => THREE.Group;
  createJoinPost: (mask: number) => THREE.Group;
  dispose: () => void;
};

const WALL_HEIGHT = 2.8 * LEVEL_EDITOR_WORLD_UNIT;
const WALL_THICKNESS = 0.18 * LEVEL_EDITOR_WORLD_UNIT;
const DEFAULT_SEGMENT_TRIM_AMOUNT = WALL_THICKNESS * 0.5;
const JUNCTION_ARM_REACH = LEVEL_EDITOR_WORLD_UNIT * 0.5;
const WALL_BLOCK_HALF_SPAN = LEVEL_EDITOR_WORLD_UNIT * 0.5;
const WALL_BLOCK_EDGE_OFFSET = WALL_BLOCK_HALF_SPAN - WALL_THICKNESS * 0.5;
const WALL_BLOCK_CORNER_OFFSET = WALL_BLOCK_HALF_SPAN;

const WALL_STRIPE_COLOR = 0xc45a12;
const WALL_STRIPE_START_PIXEL_Y = 13;
const WALL_STRIPE_END_PIXEL_Y = 17;

const JOIN_CAP_HEIGHT_EPSILON = LEVEL_EDITOR_WORLD_UNIT * 0.0025;
// Use one "big pixel" of overlap (128 cm / 32 px = 4 cm) to hide raster
// cracks between trimmed segments and junction arms in low-res upscaled render.
const JOIN_CAP_REACH_EPSILON =
  LEVEL_EDITOR_WORLD_UNIT / LEVEL_EDITOR_PIXELS_PER_UNIT_X;
const JOIN_MASK_NORTH = 1;
const JOIN_MASK_EAST = 2;
const JOIN_MASK_SOUTH = 4;
const JOIN_MASK_WEST = 8;

type StripeBand = {
  color: number;
  minY: number;
  maxY: number;
};

type JoinCapKind = "none" | "corner" | "tee" | "cross";

function applyStripeBand(material: THREE.MeshStandardMaterial, stripe: StripeBand): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStripeColor = {
      value: new THREE.Color(stripe.color)
    };
    shader.uniforms.uStripeMinY = { value: stripe.minY };
    shader.uniforms.uStripeMaxY = { value: stripe.maxY };

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `
      #include <common>
      varying float vStripeWorldY;
      `
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `
      #include <begin_vertex>
      vStripeWorldY = (modelMatrix * vec4(transformed, 1.0)).y;
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `
      #include <common>
      uniform vec3 uStripeColor;
      uniform float uStripeMinY;
      uniform float uStripeMaxY;
      varying float vStripeWorldY;
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `
      float stripeMask = step(uStripeMinY, vStripeWorldY) * (1.0 - step(uStripeMaxY, vStripeWorldY));
      outgoingLight = mix(outgoingLight, uStripeColor, stripeMask);
      #include <opaque_fragment>
      `
    );
  };

  material.customProgramCacheKey = () =>
    `pbrStripe_${stripe.color.toString(16)}_${stripe.minY.toFixed(4)}_${stripe.maxY.toFixed(4)}`;
  material.needsUpdate = true;
}

function createMaterials(): { materials: EditorStructureMaterials } {
  const stripeBand: StripeBand = {
    color: WALL_STRIPE_COLOR,
    minY:
      (WALL_STRIPE_START_PIXEL_Y / LEVEL_EDITOR_PIXELS_PER_UNIT_Y) *
      LEVEL_EDITOR_WORLD_UNIT,
    maxY:
      (WALL_STRIPE_END_PIXEL_Y / LEVEL_EDITOR_PIXELS_PER_UNIT_Y) *
      LEVEL_EDITOR_WORLD_UNIT
  };

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xfbfdff,
    roughness: 0.08,
    metalness: 0.34,
    envMapIntensity: 1.25,
    toneMapped: true
  });
  applyStripeBand(wallMaterial, stripeBand);

  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0xe7f1ff,
    roughness: 0.14,
    metalness: 0.3,
    envMapIntensity: 1.2,
    toneMapped: true
  });

  const doorMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0.42,
    envMapIntensity: 1.3,
    toneMapped: true
  });
  applyStripeBand(doorMaterial, stripeBand);

  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0xb9ddff,
    roughness: 0.04,
    metalness: 0.02,
    transparent: true,
    opacity: 0.36,
    toneMapped: true
  });

  return {
    materials: {
      wall: wallMaterial,
      accent: accentMaterial,
      windowGlass: glassMaterial,
      door: doorMaterial
    }
  };
}

function makeJoinShape(points: Array<[number, number]>): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i < points.length; i += 1) {
    const [x, z] = points[i] ?? [0, 0];
    const px = x;
    const py = -z;
    if (i === 0) {
      shape.moveTo(px, py);
    } else {
      shape.lineTo(px, py);
    }
  }
  shape.closePath();
  return shape;
}

function createJoinCapGeometry(kind: Exclude<JoinCapKind, "none">): THREE.BufferGeometry {
  const half = WALL_THICKNESS * 0.5;
  // We model the center block from [-half, half], so arm extension beyond that
  // must stop at half-tile reach. We intentionally add a tiny overlap epsilon
  // to avoid visible raster cracks between independently generated meshes.
  const reach = Math.max(0, JUNCTION_ARM_REACH - half + JOIN_CAP_REACH_EPSILON);
  const capHeight = WALL_HEIGHT + JOIN_CAP_HEIGHT_EPSILON;

  let points: Array<[number, number]>;

  if (kind === "corner") {
    points = [
      [-half, -half - reach],
      [half, -half - reach],
      [half, -half],
      [half + reach, -half],
      [half + reach, half],
      [-half, half]
    ];
  } else if (kind === "tee") {
    points = [
      [-half - reach, -half],
      [-half, -half],
      [-half, -half - reach],
      [half, -half - reach],
      [half, -half],
      [half + reach, -half],
      [half + reach, half],
      [-half - reach, half]
    ];
  } else {
    points = [
      [-half, -half - reach],
      [half, -half - reach],
      [half, -half],
      [half + reach, -half],
      [half + reach, half],
      [half, half],
      [half, half + reach],
      [-half, half + reach],
      [-half, half],
      [-half - reach, half],
      [-half - reach, -half],
      [-half, -half]
    ];
  }

  const geometry = new THREE.ExtrudeGeometry(makeJoinShape(points), {
    depth: capHeight,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1
  });
  geometry.rotateX(-Math.PI * 0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function createGeometries(): EditorStructureGeometries {
  const nodeWidth = WALL_THICKNESS;
  return {
    wallCore: new THREE.BoxGeometry(
      LEVEL_EDITOR_WORLD_UNIT,
      WALL_HEIGHT,
      WALL_THICKNESS
    ),
    windowLower: new THREE.BoxGeometry(
      LEVEL_EDITOR_WORLD_UNIT,
      0.92 * LEVEL_EDITOR_WORLD_UNIT,
      WALL_THICKNESS
    ),
    windowUpper: new THREE.BoxGeometry(
      LEVEL_EDITOR_WORLD_UNIT,
      0.92 * LEVEL_EDITOR_WORLD_UNIT,
      WALL_THICKNESS
    ),
    windowGlass: new THREE.PlaneGeometry(
      0.86 * LEVEL_EDITOR_WORLD_UNIT,
      0.86 * LEVEL_EDITOR_WORLD_UNIT
    ),
    doorLeaf: new THREE.BoxGeometry(
      0.88 * LEVEL_EDITOR_WORLD_UNIT,
      2.2 * LEVEL_EDITOR_WORLD_UNIT,
      0.08 * LEVEL_EDITOR_WORLD_UNIT
    ),
    nodeCore: new THREE.BoxGeometry(nodeWidth, WALL_HEIGHT, nodeWidth),
    joinCorner: createJoinCapGeometry("corner"),
    joinTee: createJoinCapGeometry("tee"),
    joinCross: createJoinCapGeometry("cross")
  };
}

function decodeJoinMask(mask: number): { kind: JoinCapKind; yaw: number } {
  const normalized = mask & 0b1111;
  switch (normalized) {
    case JOIN_MASK_NORTH | JOIN_MASK_EAST:
      return { kind: "corner", yaw: 0 };
    case JOIN_MASK_EAST | JOIN_MASK_SOUTH:
      return { kind: "corner", yaw: -Math.PI * 0.5 };
    case JOIN_MASK_SOUTH | JOIN_MASK_WEST:
      return { kind: "corner", yaw: Math.PI };
    case JOIN_MASK_WEST | JOIN_MASK_NORTH:
      return { kind: "corner", yaw: Math.PI * 0.5 };
    case JOIN_MASK_NORTH | JOIN_MASK_EAST | JOIN_MASK_WEST:
      return { kind: "tee", yaw: 0 };
    case JOIN_MASK_NORTH | JOIN_MASK_EAST | JOIN_MASK_SOUTH:
      return { kind: "tee", yaw: -Math.PI * 0.5 };
    case JOIN_MASK_EAST | JOIN_MASK_SOUTH | JOIN_MASK_WEST:
      return { kind: "tee", yaw: Math.PI };
    case JOIN_MASK_NORTH | JOIN_MASK_SOUTH | JOIN_MASK_WEST:
      return { kind: "tee", yaw: Math.PI * 0.5 };
    case JOIN_MASK_NORTH | JOIN_MASK_EAST | JOIN_MASK_SOUTH | JOIN_MASK_WEST:
      return { kind: "cross", yaw: 0 };
    default:
      return { kind: "none", yaw: 0 };
  }
}

export function setDoorVisualOpen(door: EditorDoorVisual, open: boolean): void {
  door.leafPivot.rotation.y = open ? -Math.PI * 0.5 : 0;
}

export function createEditorStructureMeshKit(): EditorStructureMeshKit {
  const { materials } = createMaterials();
  const geometries = createGeometries();

  const applySegmentTrim = (
    group: THREE.Group,
    options?: EditorStructureSegmentOptions
  ): THREE.Group => {
    const trimStart = options?.trimStartAmount ?? (options?.trimStart ? DEFAULT_SEGMENT_TRIM_AMOUNT : 0);
    const trimEnd = options?.trimEndAmount ?? (options?.trimEnd ? DEFAULT_SEGMENT_TRIM_AMOUNT : 0);
    const effectiveLength = Math.max(
      LEVEL_EDITOR_WORLD_UNIT * 0.1,
      LEVEL_EDITOR_WORLD_UNIT - trimStart - trimEnd
    );
    group.scale.x = effectiveLength / LEVEL_EDITOR_WORLD_UNIT;
    group.position.x = (trimStart - trimEnd) * 0.5;
    return group;
  };

  const createWallSegment = (
    options?: EditorStructureSegmentOptions
  ): THREE.Group => {
    const group = new THREE.Group();

    const core = new THREE.Mesh(geometries.wallCore, materials.wall);
    core.position.y = WALL_HEIGHT * 0.5;
    group.add(core);

    return applySegmentTrim(group, options);
  };

  const createWindowSegment = (
    options?: EditorStructureSegmentOptions
  ): THREE.Group => {
    const group = new THREE.Group();

    const lower = new THREE.Mesh(geometries.windowLower, materials.wall);
    lower.position.y = 0.46 * LEVEL_EDITOR_WORLD_UNIT;
    group.add(lower);

    const upper = new THREE.Mesh(geometries.windowUpper, materials.accent);
    upper.position.y = WALL_HEIGHT - 0.46 * LEVEL_EDITOR_WORLD_UNIT;
    group.add(upper);

    const glass = new THREE.Mesh(geometries.windowGlass, materials.windowGlass);
    glass.position.set(0, WALL_HEIGHT * 0.5, WALL_THICKNESS * 0.54);
    group.add(glass);

    return applySegmentTrim(group, options);
  };

  const createDoorVisual = (): EditorDoorVisual => {
    const root = new THREE.Group();

    const leafPivot = new THREE.Group();
    leafPivot.position.set(-0.44 * LEVEL_EDITOR_WORLD_UNIT, 0, 0);

    const leaf = new THREE.Mesh(geometries.doorLeaf, materials.door);
    leaf.position.set(
      0.44 * LEVEL_EDITOR_WORLD_UNIT,
      1.1 * LEVEL_EDITOR_WORLD_UNIT,
      0
    );
    leafPivot.add(leaf);

    root.add(leafPivot);

    return { root, leafPivot };
  };

  const createDoorSegment = (
    state: EditorStructureDoorState,
    options?: EditorStructureSegmentOptions
  ): THREE.Group => {
    const door = createDoorVisual();
    setDoorVisualOpen(door, state === "open");
    return applySegmentTrim(door.root, options);
  };

  const createJoinPost = (mask: number): THREE.Group => {
    const decoded = decodeJoinMask(mask);
    if (decoded.kind === "none") {
      return new THREE.Group();
    }

    const geometry =
      decoded.kind === "corner"
        ? geometries.joinCorner
        : decoded.kind === "tee"
          ? geometries.joinTee
          : geometries.joinCross;

    const group = new THREE.Group();
    const cap = new THREE.Mesh(geometry, materials.wall);
    cap.rotation.y = decoded.yaw;
    group.add(cap);
    return group;
  };

  const createWallBlock = (): THREE.Group => {
    const group = new THREE.Group();

    const north = createWallSegment({ trimStart: true, trimEnd: true });
    north.position.z = -WALL_BLOCK_EDGE_OFFSET;
    group.add(north);

    const south = createWallSegment({ trimStart: true, trimEnd: true });
    south.position.z = WALL_BLOCK_EDGE_OFFSET;
    group.add(south);

    const east = createWallSegment({ trimStart: true, trimEnd: true });
    east.position.x = WALL_BLOCK_EDGE_OFFSET;
    east.rotation.y = Math.PI * 0.5;
    group.add(east);

    const west = createWallSegment({ trimStart: true, trimEnd: true });
    west.position.x = -WALL_BLOCK_EDGE_OFFSET;
    west.rotation.y = Math.PI * 0.5;
    group.add(west);

    const corners: Array<[number, number, number]> = [
      [
        -WALL_BLOCK_CORNER_OFFSET,
        -WALL_BLOCK_CORNER_OFFSET,
        JOIN_MASK_EAST | JOIN_MASK_SOUTH
      ],
      [
        WALL_BLOCK_CORNER_OFFSET,
        -WALL_BLOCK_CORNER_OFFSET,
        JOIN_MASK_WEST | JOIN_MASK_SOUTH
      ],
      [
        WALL_BLOCK_CORNER_OFFSET,
        WALL_BLOCK_CORNER_OFFSET,
        JOIN_MASK_WEST | JOIN_MASK_NORTH
      ],
      [
        -WALL_BLOCK_CORNER_OFFSET,
        WALL_BLOCK_CORNER_OFFSET,
        JOIN_MASK_EAST | JOIN_MASK_NORTH
      ]
    ];

    for (const [x, z, mask] of corners) {
      const post = createJoinPost(mask);
      post.position.set(x, 0, z);
      group.add(post);
    }

    return group;
  };

  const dispose = (): void => {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    Object.values(materials).forEach((material) => material.dispose());
  };

  return {
    createWallSegment,
    createWallBlock,
    createWindowSegment,
    createDoorVisual,
    createDoorSegment,
    createJoinPost,
    dispose
  };
}
