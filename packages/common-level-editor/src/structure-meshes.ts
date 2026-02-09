import * as THREE from "three";
import {
  LEVEL_EDITOR_PIXELS_PER_UNIT_Y,
  LEVEL_EDITOR_WORLD_UNIT
} from "./constants";

export type EditorStructureDoorState = "open" | "closed";

export type EditorDoorVisual = {
  root: THREE.Group;
  leafPivot: THREE.Group;
};

type EditorStructureMaterials = {
  wall: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  windowGlass: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
  joint: THREE.MeshStandardMaterial;
};

type EditorStructureGeometries = {
  wallCore: THREE.BoxGeometry;
  windowLower: THREE.BoxGeometry;
  windowUpper: THREE.BoxGeometry;
  windowGlass: THREE.PlaneGeometry;
  doorLeaf: THREE.BoxGeometry;
  nodeCore: THREE.BoxGeometry;
  nodeCapCore: THREE.BoxGeometry;
  nodeCapArmX: THREE.BoxGeometry;
  nodeCapArmZ: THREE.BoxGeometry;
};

export type EditorStructureMeshKit = {
  createWallSegment: () => THREE.Group;
  createWallBlock: () => THREE.Group;
  createWindowSegment: () => THREE.Group;
  createDoorVisual: () => EditorDoorVisual;
  createDoorSegment: (state: EditorStructureDoorState) => THREE.Group;
  createJoinPost: (mask: number) => THREE.Group;
  dispose: () => void;
};

const WALL_HEIGHT = 2.8 * LEVEL_EDITOR_WORLD_UNIT;
const WALL_THICKNESS = 0.18 * LEVEL_EDITOR_WORLD_UNIT;
const WALL_BLOCK_HALF_SPAN = LEVEL_EDITOR_WORLD_UNIT * 0.5;
const WALL_BLOCK_EDGE_OFFSET = WALL_BLOCK_HALF_SPAN - WALL_THICKNESS * 0.5;
const WALL_BLOCK_CORNER_OFFSET = WALL_BLOCK_HALF_SPAN;
const WALL_STRIPE_COLOR = 0xc45a12;
const WALL_STRIPE_START_PIXEL_Y = 13;
const WALL_STRIPE_END_PIXEL_Y = 17;
const JOIN_CAP_OVERLAP = WALL_THICKNESS * 0.12;
const JOIN_CAP_HEIGHT_EPSILON = LEVEL_EDITOR_WORLD_UNIT * 0.003;
const JOIN_MASK_NORTH = 1;
const JOIN_MASK_EAST = 2;
const JOIN_MASK_SOUTH = 4;
const JOIN_MASK_WEST = 8;

type StripeBand = {
  color: number;
  minY: number;
  maxY: number;
};

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

  const jointMaterial = new THREE.MeshStandardMaterial({
    color: 0xf2f8ff,
    roughness: 0.12,
    metalness: 0.36,
    envMapIntensity: 1.25,
    toneMapped: true
  });
  applyStripeBand(jointMaterial, stripeBand);

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
      door: doorMaterial,
      joint: jointMaterial
    }
  };
}

function createGeometries(): EditorStructureGeometries {
  const nodeWidth = WALL_THICKNESS;
  const capHeight = WALL_HEIGHT + JOIN_CAP_HEIGHT_EPSILON;
  const armLength = WALL_THICKNESS * 0.5 + JOIN_CAP_OVERLAP;
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
    nodeCapCore: new THREE.BoxGeometry(nodeWidth, capHeight, nodeWidth),
    nodeCapArmX: new THREE.BoxGeometry(armLength, capHeight, nodeWidth),
    nodeCapArmZ: new THREE.BoxGeometry(nodeWidth, capHeight, armLength)
  };
}

export function setDoorVisualOpen(door: EditorDoorVisual, open: boolean): void {
  door.leafPivot.rotation.y = open ? -Math.PI * 0.5 : 0;
}

export function createEditorStructureMeshKit(): EditorStructureMeshKit {
  const { materials } = createMaterials();
  const geometries = createGeometries();

  const createWallSegment = (): THREE.Group => {
    const group = new THREE.Group();

    const core = new THREE.Mesh(geometries.wallCore, materials.wall);
    core.position.y = WALL_HEIGHT * 0.5;
    group.add(core);

    return group;
  };

  const createWindowSegment = (): THREE.Group => {
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

    return group;
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

  const createDoorSegment = (state: EditorStructureDoorState): THREE.Group => {
    const door = createDoorVisual();
    setDoorVisualOpen(door, state === "open");
    return door.root;
  };

  const createJoinPost = (mask: number): THREE.Group => {
    const connections = ((mask & JOIN_MASK_NORTH) ? 1 : 0) +
      ((mask & JOIN_MASK_EAST) ? 1 : 0) +
      ((mask & JOIN_MASK_SOUTH) ? 1 : 0) +
      ((mask & JOIN_MASK_WEST) ? 1 : 0);
    const straight =
      mask === (JOIN_MASK_NORTH | JOIN_MASK_SOUTH) ||
      mask === (JOIN_MASK_EAST | JOIN_MASK_WEST);

    if (connections < 2 || straight) {
      return new THREE.Group();
    }

    const group = new THREE.Group();

    const capHeight = WALL_HEIGHT + JOIN_CAP_HEIGHT_EPSILON;
    const core = new THREE.Mesh(geometries.nodeCapCore, materials.joint);
    core.position.y = capHeight * 0.5;
    group.add(core);

    const armLength = WALL_THICKNESS * 0.5 + JOIN_CAP_OVERLAP;
    const armCenter = WALL_THICKNESS * 0.5 + armLength * 0.5 - JOIN_CAP_OVERLAP * 0.5;
    const addArm = (x: number, z: number, alongX: boolean): void => {
      const arm = new THREE.Mesh(
        alongX ? geometries.nodeCapArmX : geometries.nodeCapArmZ,
        materials.joint
      );
      arm.position.set(x, capHeight * 0.5, z);
      group.add(arm);
    };

    if (mask & JOIN_MASK_NORTH) {
      addArm(0, -armCenter, false);
    }
    if (mask & JOIN_MASK_EAST) {
      addArm(armCenter, 0, true);
    }
    if (mask & JOIN_MASK_SOUTH) {
      addArm(0, armCenter, false);
    }
    if (mask & JOIN_MASK_WEST) {
      addArm(-armCenter, 0, true);
    }

    return group;
  };

  const createWallBlock = (): THREE.Group => {
    const group = new THREE.Group();

    const north = createWallSegment();
    north.position.z = -WALL_BLOCK_EDGE_OFFSET;
    group.add(north);

    const south = createWallSegment();
    south.position.z = WALL_BLOCK_EDGE_OFFSET;
    group.add(south);

    const east = createWallSegment();
    east.position.x = WALL_BLOCK_EDGE_OFFSET;
    east.rotation.y = Math.PI * 0.5;
    group.add(east);

    const west = createWallSegment();
    west.position.x = -WALL_BLOCK_EDGE_OFFSET;
    west.rotation.y = Math.PI * 0.5;
    group.add(west);

    const corners: Array<[number, number, number]> = [
      [-WALL_BLOCK_CORNER_OFFSET, -WALL_BLOCK_CORNER_OFFSET, JOIN_MASK_EAST | JOIN_MASK_SOUTH],
      [WALL_BLOCK_CORNER_OFFSET, -WALL_BLOCK_CORNER_OFFSET, JOIN_MASK_WEST | JOIN_MASK_SOUTH],
      [WALL_BLOCK_CORNER_OFFSET, WALL_BLOCK_CORNER_OFFSET, JOIN_MASK_WEST | JOIN_MASK_NORTH],
      [-WALL_BLOCK_CORNER_OFFSET, WALL_BLOCK_CORNER_OFFSET, JOIN_MASK_EAST | JOIN_MASK_NORTH]
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
