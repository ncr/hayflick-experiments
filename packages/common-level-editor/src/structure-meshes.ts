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

export type EditorStructureSegmentOptions = {
  trimStart?: boolean;
  trimEnd?: boolean;
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
  createJoinPost: (degree: number, straight?: boolean) => THREE.Group;
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
const SEGMENT_TRIM_AMOUNT = WALL_THICKNESS * 0.5;

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
    nodeCore: new THREE.BoxGeometry(nodeWidth, WALL_HEIGHT, nodeWidth)
  };
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
    const trimStart = options?.trimStart ? SEGMENT_TRIM_AMOUNT : 0;
    const trimEnd = options?.trimEnd ? SEGMENT_TRIM_AMOUNT : 0;
    const effectiveLength = Math.max(
      LEVEL_EDITOR_WORLD_UNIT * 0.1,
      LEVEL_EDITOR_WORLD_UNIT - trimStart - trimEnd
    );
    group.scale.x = effectiveLength / LEVEL_EDITOR_WORLD_UNIT;
    group.position.x = (trimStart - trimEnd) * 0.5;
    return group;
  };

  const createWallSegment = (options?: EditorStructureSegmentOptions): THREE.Group => {
    const group = new THREE.Group();

    const core = new THREE.Mesh(geometries.wallCore, materials.wall);
    core.position.y = WALL_HEIGHT * 0.5;
    group.add(core);

    return applySegmentTrim(group, options);
  };

  const createWindowSegment = (options?: EditorStructureSegmentOptions): THREE.Group => {
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

  const createJoinPost = (degree: number, straight = false): THREE.Group => {
    if (degree < 2 || straight) {
      return new THREE.Group();
    }

    const group = new THREE.Group();

    const core = new THREE.Mesh(geometries.nodeCore, materials.joint);
    core.position.y = WALL_HEIGHT * 0.5;
    group.add(core);

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

    const corners: Array<[number, number]> = [
      [-WALL_BLOCK_CORNER_OFFSET, -WALL_BLOCK_CORNER_OFFSET],
      [WALL_BLOCK_CORNER_OFFSET, -WALL_BLOCK_CORNER_OFFSET],
      [WALL_BLOCK_CORNER_OFFSET, WALL_BLOCK_CORNER_OFFSET],
      [-WALL_BLOCK_CORNER_OFFSET, WALL_BLOCK_CORNER_OFFSET]
    ];

    for (const [x, z] of corners) {
      const post = createJoinPost(2);
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
