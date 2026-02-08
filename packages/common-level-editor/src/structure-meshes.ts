import * as THREE from "three";

export type EditorStructureDoorState = "open" | "closed";

export type EditorDoorVisual = {
  root: THREE.Group;
  leafPivot: THREE.Group;
};

type EditorStructureMaterials = {
  wall: THREE.MeshStandardMaterial;
  wallTrim: THREE.MeshStandardMaterial;
  windowFrame: THREE.MeshStandardMaterial;
  windowGlass: THREE.MeshStandardMaterial;
  doorFrame: THREE.MeshStandardMaterial;
  doorLeaf: THREE.MeshStandardMaterial;
  doorHandle: THREE.MeshStandardMaterial;
  joint: THREE.MeshStandardMaterial;
};

type EditorStructureGeometries = {
  wallCore: THREE.BoxGeometry;
  wallCap: THREE.BoxGeometry;
  wallBase: THREE.BoxGeometry;
  windowLower: THREE.BoxGeometry;
  windowUpper: THREE.BoxGeometry;
  windowSide: THREE.BoxGeometry;
  windowInset: THREE.BoxGeometry;
  windowGlass: THREE.PlaneGeometry;
  doorJamb: THREE.BoxGeometry;
  doorHeader: THREE.BoxGeometry;
  doorThreshold: THREE.BoxGeometry;
  doorLeaf: THREE.BoxGeometry;
  doorHandle: THREE.CylinderGeometry;
  jointColumn: THREE.BoxGeometry;
  jointCap: THREE.BoxGeometry;
};

export type EditorStructureMeshKit = {
  createWallSegment: () => THREE.Group;
  createWallBlock: () => THREE.Group;
  createWindowSegment: () => THREE.Group;
  createDoorVisual: () => EditorDoorVisual;
  createDoorSegment: (state: EditorStructureDoorState) => THREE.Group;
  createJoinPost: (degree: number) => THREE.Group;
  dispose: () => void;
};

const WALL_HEIGHT = 2.8;
const WALL_THICKNESS = 0.2;
const WALL_BLOCK_EDGE_OFFSET = 0.4;
const WALL_BLOCK_CORNER_OFFSET = 0.5;

function createMaterials(): EditorStructureMaterials {
  return {
    wall: new THREE.MeshStandardMaterial({
      color: 0xc4cfd8,
      roughness: 0.66,
      metalness: 0.04
    }),
    wallTrim: new THREE.MeshStandardMaterial({
      color: 0xb1bec9,
      roughness: 0.58,
      metalness: 0.06
    }),
    windowFrame: new THREE.MeshStandardMaterial({
      color: 0x8aa4ba,
      roughness: 0.58,
      metalness: 0.09
    }),
    windowGlass: new THREE.MeshStandardMaterial({
      color: 0x9bd5f3,
      roughness: 0.17,
      metalness: 0,
      transparent: true,
      opacity: 0.44
    }),
    doorFrame: new THREE.MeshStandardMaterial({
      color: 0xc8a074,
      roughness: 0.68,
      metalness: 0.04
    }),
    doorLeaf: new THREE.MeshStandardMaterial({
      color: 0x986542,
      roughness: 0.62,
      metalness: 0.03
    }),
    doorHandle: new THREE.MeshStandardMaterial({
      color: 0xe7d18f,
      roughness: 0.26,
      metalness: 0.42
    }),
    joint: new THREE.MeshStandardMaterial({
      color: 0xe6dcc0,
      roughness: 0.56,
      metalness: 0.08
    })
  };
}

function createGeometries(): EditorStructureGeometries {
  const doorHandle = new THREE.CylinderGeometry(0.02, 0.02, 0.12, 10);
  doorHandle.rotateZ(Math.PI * 0.5);

  return {
    wallCore: new THREE.BoxGeometry(1, 2.48, WALL_THICKNESS * 0.85),
    wallCap: new THREE.BoxGeometry(1, 0.13, WALL_THICKNESS + 0.06),
    wallBase: new THREE.BoxGeometry(1, 0.18, WALL_THICKNESS + 0.04),
    windowLower: new THREE.BoxGeometry(1, 0.96, WALL_THICKNESS * 0.88),
    windowUpper: new THREE.BoxGeometry(1, 0.76, WALL_THICKNESS * 0.88),
    windowSide: new THREE.BoxGeometry(0.16, 1.1, WALL_THICKNESS * 0.88),
    windowInset: new THREE.BoxGeometry(0.72, 1.0, 0.08),
    windowGlass: new THREE.PlaneGeometry(0.66, 0.94),
    doorJamb: new THREE.BoxGeometry(0.12, 2.34, WALL_THICKNESS + 0.04),
    doorHeader: new THREE.BoxGeometry(1, 0.24, WALL_THICKNESS + 0.04),
    doorThreshold: new THREE.BoxGeometry(0.92, 0.07, WALL_THICKNESS * 0.85),
    doorLeaf: new THREE.BoxGeometry(0.72, 2.02, 0.06),
    doorHandle,
    jointColumn: new THREE.BoxGeometry(0.22, WALL_HEIGHT, 0.22),
    jointCap: new THREE.BoxGeometry(0.3, 0.12, 0.3)
  };
}

export function setDoorVisualOpen(door: EditorDoorVisual, open: boolean): void {
  door.leafPivot.rotation.y = open ? -Math.PI * 0.5 : 0;
}

export function createEditorStructureMeshKit(): EditorStructureMeshKit {
  const materials = createMaterials();
  const geometries = createGeometries();

  const createWallSegment = (): THREE.Group => {
    const group = new THREE.Group();

    const core = new THREE.Mesh(geometries.wallCore, materials.wall);
    core.position.y = 1.34;
    group.add(core);

    const top = new THREE.Mesh(geometries.wallCap, materials.wallTrim);
    top.position.y = 2.73;
    group.add(top);

    const base = new THREE.Mesh(geometries.wallBase, materials.wallTrim);
    base.position.y = 0.09;
    group.add(base);

    return group;
  };

  const createWindowSegment = (): THREE.Group => {
    const group = new THREE.Group();

    const lower = new THREE.Mesh(geometries.windowLower, materials.wall);
    lower.position.y = 0.48;
    group.add(lower);

    const upper = new THREE.Mesh(geometries.windowUpper, materials.wall);
    upper.position.y = 2.42;
    group.add(upper);

    const left = new THREE.Mesh(geometries.windowSide, materials.windowFrame);
    left.position.set(-0.42, 1.45, 0);
    group.add(left);

    const right = new THREE.Mesh(geometries.windowSide, materials.windowFrame);
    right.position.set(0.42, 1.45, 0);
    group.add(right);

    const inset = new THREE.Mesh(geometries.windowInset, materials.windowFrame);
    inset.position.y = 1.45;
    group.add(inset);

    const glass = new THREE.Mesh(geometries.windowGlass, materials.windowGlass);
    glass.position.set(0, 1.45, 0.05);
    group.add(glass);

    const top = new THREE.Mesh(geometries.wallCap, materials.wallTrim);
    top.position.y = 2.73;
    group.add(top);

    const base = new THREE.Mesh(geometries.wallBase, materials.wallTrim);
    base.position.y = 0.09;
    group.add(base);

    return group;
  };

  const createDoorVisual = (): EditorDoorVisual => {
    const root = new THREE.Group();

    const leftJamb = new THREE.Mesh(geometries.doorJamb, materials.doorFrame);
    leftJamb.position.set(-0.43, 1.17, 0);
    root.add(leftJamb);

    const rightJamb = new THREE.Mesh(geometries.doorJamb, materials.doorFrame);
    rightJamb.position.set(0.43, 1.17, 0);
    root.add(rightJamb);

    const header = new THREE.Mesh(geometries.doorHeader, materials.doorFrame);
    header.position.y = 2.46;
    root.add(header);

    const threshold = new THREE.Mesh(geometries.doorThreshold, materials.doorFrame);
    threshold.position.y = 0.035;
    root.add(threshold);

    const leafPivot = new THREE.Group();
    leafPivot.position.set(-0.36, 0, 0);

    const leaf = new THREE.Mesh(geometries.doorLeaf, materials.doorLeaf);
    leaf.position.set(0.36, 1.01, 0);
    leafPivot.add(leaf);

    const handle = new THREE.Mesh(geometries.doorHandle, materials.doorHandle);
    handle.position.set(0.66, 1.02, 0.05);
    leafPivot.add(handle);

    root.add(leafPivot);

    return { root, leafPivot };
  };

  const createDoorSegment = (state: EditorStructureDoorState): THREE.Group => {
    const door = createDoorVisual();
    setDoorVisualOpen(door, state === "open");
    return door.root;
  };

  const createJoinPost = (degree: number): THREE.Group => {
    const group = new THREE.Group();

    const column = new THREE.Mesh(geometries.jointColumn, materials.joint);
    const scale = 0.92 + degree * 0.14;
    column.scale.x = scale;
    column.scale.z = scale;
    column.position.y = WALL_HEIGHT * 0.5;
    group.add(column);

    const cap = new THREE.Mesh(geometries.jointCap, materials.joint);
    cap.scale.x = 0.95 + degree * 0.1;
    cap.scale.z = 0.95 + degree * 0.1;
    cap.position.y = WALL_HEIGHT + 0.06;
    group.add(cap);

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
