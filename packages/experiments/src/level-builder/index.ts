import * as THREE from "three";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

type StructureSegmentType = "wall" | "window" | "door";
type GroundTileType = "floor" | "grass";
type BrushType = StructureSegmentType | GroundTileType;
type ToolMode = "draw" | "erase";

type GridEdge = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
};

type GridCell = {
  x: number;
  z: number;
};

type DirectionVector = {
  dx: number;
  dz: number;
};

type DragState = {
  pointerId: number;
  mode: "paint" | "pan";
  paintMode: ToolMode;
  brush: BrushType;
  lastClientX: number;
  lastClientY: number;
  lastWorldPoint: THREE.Vector3 | null;
};

const GRID_TILES = 30;
const TILE_SIZE = 1;
const GRID_ORIGIN = -(GRID_TILES * TILE_SIZE) * 0.5;

const STRUCTURE_HEIGHTS: Record<StructureSegmentType, number> = {
  wall: 2.8,
  window: 2.1,
  door: 2.3
};

const WALL_THICKNESS = 0.18;
const GROUND_TILE_HEIGHT = 0.05;
const DEFAULT_GROUND: GroundTileType = "floor";

const ORTHO_HEIGHT = 28;
const CAMERA_DISTANCE = 34;
const CAMERA_PITCH = THREE.MathUtils.degToRad(35.26438968);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 3.8;
const PAN_CLAMP = GRID_TILES * 0.8;

const BRUSH_COLORS: Record<BrushType, number> = {
  wall: 0xbec7d0,
  window: 0x8ccdee,
  door: 0xd9b17f,
  floor: 0x7f95ab,
  grass: 0x5ca063
};

function isGroundBrush(brush: BrushType): brush is GroundTileType {
  return brush === "floor" || brush === "grass";
}

function nodeKey(x: number, z: number): string {
  return `${x},${z}`;
}

function cellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function edgeKey(ax: number, az: number, bx: number, bz: number): string {
  if (ax < bx || (ax === bx && az <= bz)) {
    return `${ax},${az}|${bx},${bz}`;
  }
  return `${bx},${bz}|${ax},${az}`;
}

function parseEdge(key: string): GridEdge {
  const [a, b] = key.split("|");
  const [axStr, azStr] = a.split(",");
  const [bxStr, bzStr] = b.split(",");
  return {
    ax: Number(axStr),
    az: Number(azStr),
    bx: Number(bxStr),
    bz: Number(bzStr)
  };
}

function toWorldNodeX(x: number): number {
  return GRID_ORIGIN + x * TILE_SIZE;
}

function toWorldNodeZ(z: number): number {
  return GRID_ORIGIN + z * TILE_SIZE;
}

function toWorldCellX(x: number): number {
  return GRID_ORIGIN + x * TILE_SIZE + TILE_SIZE * 0.5;
}

function toWorldCellZ(z: number): number {
  return GRID_ORIGIN + z * TILE_SIZE + TILE_SIZE * 0.5;
}

function clampPanTarget(target: THREE.Vector3): void {
  target.x = THREE.MathUtils.clamp(target.x, -PAN_CLAMP, PAN_CLAMP);
  target.z = THREE.MathUtils.clamp(target.z, -PAN_CLAMP, PAN_CLAMP);
}

function dampAngle(current: number, target: number, factor: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * factor;
}

function createGridGeometry(step: number, y: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const worldSpan = GRID_TILES * TILE_SIZE;
  const start = GRID_ORIGIN;
  const end = start + worldSpan;

  for (let i = 0; i <= GRID_TILES; i += step) {
    const offset = i * TILE_SIZE;
    const x = start + offset;
    const z = start + offset;

    positions.push(x, y, start, x, y, end);
    positions.push(start, y, z, end, y, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function parseCellKey(key: string): GridCell {
  const [xStr, zStr] = key.split(",");
  return { x: Number(xStr), z: Number(zStr) };
}

const experiment: ExperimentModule = {
  id: "level-builder",
  title: "Level Builder",
  tags: ["threejs", "editor", "isometric", "level-design", "tools"],
  init: ({ mount, width, height, dpr }) => {
    mount.style.position = "relative";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c1822);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    let viewportWidth = Math.max(1, width);
    let viewportHeight = Math.max(1, height);

    const renderer = makeRenderer(viewportWidth, viewportHeight, dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewportWidth, viewportHeight, true);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.outline = "none";
    renderer.domElement.tabIndex = 0;
    mount.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xcde5ff, 0x26303d, 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xf5f2e7, 1.1);
    keyLight.position.set(18, 24, 12);
    scene.add(keyLight);

    const floorBaseGeometry = new THREE.PlaneGeometry(GRID_TILES * TILE_SIZE, GRID_TILES * TILE_SIZE);
    const floorBaseMaterial = new THREE.MeshStandardMaterial({
      color: 0x172430,
      roughness: 0.95,
      metalness: 0.02
    });
    const floorBase = new THREE.Mesh(floorBaseGeometry, floorBaseMaterial);
    floorBase.rotation.x = -Math.PI * 0.5;
    scene.add(floorBase);

    const minorGridGeometry = createGridGeometry(1, 0.001);
    const majorGridGeometry = createGridGeometry(5, 0.002);
    const minorGrid = new THREE.LineSegments(
      minorGridGeometry,
      new THREE.LineBasicMaterial({ color: 0x375069, transparent: true, opacity: 0.42 })
    );
    const majorGrid = new THREE.LineSegments(
      majorGridGeometry,
      new THREE.LineBasicMaterial({ color: 0x5d7f9d, transparent: true, opacity: 0.7 })
    );
    scene.add(minorGrid);
    scene.add(majorGrid);

    const groundGroup = new THREE.Group();
    const structuresGroup = new THREE.Group();
    const jointsGroup = new THREE.Group();
    scene.add(groundGroup);
    scene.add(structuresGroup);
    scene.add(jointsGroup);

    const groundFloorMaterial = new THREE.MeshStandardMaterial({
      color: 0x788ea3,
      roughness: 0.86,
      metalness: 0.05
    });
    const groundGrassMaterial = new THREE.MeshStandardMaterial({
      color: 0x5a9961,
      roughness: 0.93,
      metalness: 0.0
    });

    const structureMaterials: Record<StructureSegmentType, THREE.MeshStandardMaterial> = {
      wall: new THREE.MeshStandardMaterial({ color: BRUSH_COLORS.wall, roughness: 0.66, metalness: 0.04 }),
      window: new THREE.MeshStandardMaterial({ color: BRUSH_COLORS.window, roughness: 0.62, metalness: 0.08 }),
      door: new THREE.MeshStandardMaterial({ color: BRUSH_COLORS.door, roughness: 0.7, metalness: 0.03 })
    };

    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0xe7ddb8,
      roughness: 0.56,
      metalness: 0.08
    });

    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: BRUSH_COLORS.wall,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    });

    const groundTileGeometry = new THREE.BoxGeometry(TILE_SIZE, GROUND_TILE_HEIGHT, TILE_SIZE);
    const segmentGeometry = new THREE.BoxGeometry(TILE_SIZE, 1, WALL_THICKNESS);
    const jointGeometry = new THREE.BoxGeometry(1, 2.8, 1);

    const edgeHoverGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.05, WALL_THICKNESS);
    const cellHoverGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.04, TILE_SIZE);

    const edgeHoverMesh = new THREE.Mesh(edgeHoverGeometry, hoverMaterial);
    edgeHoverMesh.visible = false;
    edgeHoverMesh.position.y = 0.03;

    const cellHoverMesh = new THREE.Mesh(cellHoverGeometry, hoverMaterial);
    cellHoverMesh.visible = false;
    cellHoverMesh.position.y = 0.03;

    scene.add(edgeHoverMesh);
    scene.add(cellHoverMesh);

    const structureSegments = new Map<string, StructureSegmentType>();
    const groundOverrides = new Map<string, GroundTileType>();

    let activeBrush: BrushType = "wall";
    let activeTool: ToolMode = "draw";
    let spacePressed = false;
    let dragState: DragState | null = null;

    let yawIndex = 0;
    let yawCurrent = CAMERA_BASE_YAW;
    let zoomTarget = 1.15;
    let zoomCurrent = zoomTarget;
    const cameraTarget = new THREE.Vector3(0, 0, 0);

    let intersectionCount = 0;
    let needsRebuild = true;
    let raf = 0;

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const panRight = new THREE.Vector3();
    const panForward = new THREE.Vector3();
    const panWorld = new THREE.Vector3();

    const strokePoint = new THREE.Vector3();
    const nextWorldPoint = new THREE.Vector3();
    const tempMatrix = new THREE.Matrix4();

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.inset = "12px";
    hud.style.display = "flex";
    hud.style.justifyContent = "space-between";
    hud.style.alignItems = "flex-start";
    hud.style.pointerEvents = "none";
    hud.style.fontFamily = "\"IBM Plex Sans\", \"Segoe UI\", sans-serif";
    hud.style.color = "#d8e8f4";
    hud.style.gap = "12px";
    mount.appendChild(hud);

    const panelStyle = (panel: HTMLDivElement) => {
      panel.style.background = "rgba(9, 17, 25, 0.76)";
      panel.style.border = "1px solid rgba(121, 153, 177, 0.45)";
      panel.style.borderRadius = "10px";
      panel.style.padding = "10px";
      panel.style.pointerEvents = "auto";
      panel.style.backdropFilter = "blur(6px)";
      panel.style.display = "flex";
      panel.style.flexDirection = "column";
      panel.style.gap = "8px";
    };

    const leftPanel = document.createElement("div");
    panelStyle(leftPanel);
    leftPanel.style.width = "min(350px, 50vw)";
    hud.appendChild(leftPanel);

    const rightPanel = document.createElement("div");
    panelStyle(rightPanel);
    rightPanel.style.minWidth = "220px";
    rightPanel.style.alignItems = "stretch";
    hud.appendChild(rightPanel);

    const title = document.createElement("div");
    title.textContent = "Level Builder";
    title.style.fontWeight = "600";
    title.style.letterSpacing = "0.02em";
    leftPanel.appendChild(title);

    const helper = document.createElement("div");
    helper.textContent = "Simple blockout meshes with auto wall joins + paintable floor/grass terrain.";
    helper.style.fontSize = "12px";
    helper.style.lineHeight = "1.3";
    helper.style.color = "rgba(207, 225, 240, 0.88)";
    leftPanel.appendChild(helper);

    function makeRow(label: string): HTMLDivElement {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "72px 1fr";
      row.style.alignItems = "center";
      row.style.gap = "8px";

      const caption = document.createElement("span");
      caption.textContent = label;
      caption.style.fontSize = "12px";
      caption.style.opacity = "0.82";
      row.appendChild(caption);

      const controls = document.createElement("div");
      controls.style.display = "flex";
      controls.style.flexWrap = "wrap";
      controls.style.gap = "6px";
      row.appendChild(controls);

      leftPanel.appendChild(row);
      return controls;
    }

    function makeButton(label: string, onClick: () => void): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.border = "1px solid rgba(124, 155, 178, 0.62)";
      button.style.background = "rgba(20, 35, 49, 0.92)";
      button.style.color = "#d8e8f4";
      button.style.padding = "4px 8px";
      button.style.borderRadius = "8px";
      button.style.cursor = "pointer";
      button.style.fontSize = "12px";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        onClick();
        renderer.domElement.focus();
      });
      return button;
    }

    function setButtonActive(button: HTMLButtonElement, active: boolean): void {
      if (active) {
        button.style.background = "rgba(78, 136, 177, 0.9)";
        button.style.borderColor = "rgba(150, 197, 229, 0.95)";
        button.style.color = "#f3fbff";
      } else {
        button.style.background = "rgba(20, 35, 49, 0.92)";
        button.style.borderColor = "rgba(124, 155, 178, 0.62)";
        button.style.color = "#d8e8f4";
      }
    }

    function getCurrentBrushAndMode(): { brush: BrushType; mode: ToolMode } {
      if (dragState && dragState.mode === "paint") {
        return { brush: dragState.brush, mode: dragState.paintMode };
      }
      return { brush: activeBrush, mode: activeTool };
    }

    function getGroundTypeAtCell(x: number, z: number): GroundTileType {
      return groundOverrides.get(cellKey(x, z)) ?? DEFAULT_GROUND;
    }

    function setGroundTypeAtCell(x: number, z: number, type: GroundTileType): void {
      const key = cellKey(x, z);
      if (type === DEFAULT_GROUND) {
        groundOverrides.delete(key);
      } else {
        groundOverrides.set(key, type);
      }
    }

    function clearGroup(group: THREE.Group): void {
      for (let i = group.children.length - 1; i >= 0; i -= 1) {
        group.remove(group.children[i]);
      }
    }

    function createGroundInstances(material: THREE.Material, count: number): THREE.InstancedMesh {
      const mesh = new THREE.InstancedMesh(groundTileGeometry, material, Math.max(1, count));
      mesh.count = count;
      return mesh;
    }

    function createStructureSegment(type: StructureSegmentType): THREE.Mesh {
      const mesh = new THREE.Mesh(segmentGeometry, structureMaterials[type]);
      const height = STRUCTURE_HEIGHTS[type];
      mesh.scale.y = height;
      mesh.position.y = height * 0.5;
      return mesh;
    }

    function createJoinPost(degree: number): THREE.Mesh {
      const mesh = new THREE.Mesh(jointGeometry, jointMaterial);
      const size = 0.22 + degree * 0.06;
      mesh.scale.x = size;
      mesh.scale.z = size;
      mesh.position.y = 2.8 * 0.5;
      return mesh;
    }

    function registerDirection(map: Map<string, DirectionVector[]>, x: number, z: number, dx: number, dz: number): void {
      const key = nodeKey(x, z);
      const directions = map.get(key) ?? [];
      if (!directions.some((entry) => entry.dx === dx && entry.dz === dz)) {
        directions.push({ dx, dz });
      }
      map.set(key, directions);
    }

    function rebuildGroundTiles(): void {
      clearGroup(groundGroup);

      const grassCount = groundOverrides.size;
      const totalCells = GRID_TILES * GRID_TILES;
      const floorCount = totalCells - grassCount;

      const floorInstances = createGroundInstances(groundFloorMaterial, floorCount);
      const grassInstances = createGroundInstances(groundGrassMaterial, grassCount);

      let floorIndex = 0;
      let grassIndex = 0;

      for (let z = 0; z < GRID_TILES; z += 1) {
        for (let x = 0; x < GRID_TILES; x += 1) {
          tempMatrix.makeTranslation(toWorldCellX(x), GROUND_TILE_HEIGHT * 0.5, toWorldCellZ(z));

          if (getGroundTypeAtCell(x, z) === "grass") {
            grassInstances.setMatrixAt(grassIndex, tempMatrix);
            grassIndex += 1;
          } else {
            floorInstances.setMatrixAt(floorIndex, tempMatrix);
            floorIndex += 1;
          }
        }
      }

      floorInstances.instanceMatrix.needsUpdate = true;
      grassInstances.instanceMatrix.needsUpdate = true;

      groundGroup.add(floorInstances);
      groundGroup.add(grassInstances);
    }

    function rebuildStructures(): void {
      clearGroup(structuresGroup);
      clearGroup(jointsGroup);

      const adjacency = new Map<string, DirectionVector[]>();
      intersectionCount = 0;

      structureSegments.forEach((segmentType, segmentKey) => {
        const edge = parseEdge(segmentKey);
        const segment = createStructureSegment(segmentType);

        const xA = toWorldNodeX(edge.ax);
        const zA = toWorldNodeZ(edge.az);
        const xB = toWorldNodeX(edge.bx);
        const zB = toWorldNodeZ(edge.bz);

        segment.position.set((xA + xB) * 0.5, segment.position.y, (zA + zB) * 0.5);
        if (edge.az !== edge.bz) {
          segment.rotation.y = Math.PI * 0.5;
        }

        structuresGroup.add(segment);

        registerDirection(adjacency, edge.ax, edge.az, edge.bx - edge.ax, edge.bz - edge.az);
        registerDirection(adjacency, edge.bx, edge.bz, edge.ax - edge.bx, edge.az - edge.bz);
      });

      adjacency.forEach((directions, key) => {
        if (directions.length < 2) {
          return;
        }

        const { x, z } = parseCellKey(key);
        const post = createJoinPost(directions.length);
        post.position.x = toWorldNodeX(x);
        post.position.z = toWorldNodeZ(z);
        jointsGroup.add(post);

        intersectionCount += 1;
      });
    }

    const toolButtons = new Map<ToolMode, HTMLButtonElement>();
    const brushButtons = new Map<BrushType, HTMLButtonElement>();

    const toolRow = makeRow("Tool");
    const drawButton = makeButton("Draw (D)", () => {
      activeTool = "draw";
      syncHud();
    });
    const eraseButton = makeButton("Erase (X)", () => {
      activeTool = "erase";
      syncHud();
    });
    toolButtons.set("draw", drawButton);
    toolButtons.set("erase", eraseButton);
    toolRow.append(drawButton, eraseButton);

    const brushRow = makeRow("Brush");
    const wallBrushButton = makeButton("Wall (1)", () => {
      activeBrush = "wall";
      syncHud();
    });
    const windowBrushButton = makeButton("Window (2)", () => {
      activeBrush = "window";
      syncHud();
    });
    const doorBrushButton = makeButton("Door (3)", () => {
      activeBrush = "door";
      syncHud();
    });
    const floorBrushButton = makeButton("Floor (4)", () => {
      activeBrush = "floor";
      syncHud();
    });
    const grassBrushButton = makeButton("Grass (5)", () => {
      activeBrush = "grass";
      syncHud();
    });

    brushButtons.set("wall", wallBrushButton);
    brushButtons.set("window", windowBrushButton);
    brushButtons.set("door", doorBrushButton);
    brushButtons.set("floor", floorBrushButton);
    brushButtons.set("grass", grassBrushButton);

    brushRow.append(wallBrushButton, windowBrushButton, doorBrushButton, floorBrushButton, grassBrushButton);

    const cameraRow = makeRow("Camera");
    const rotateLeftButton = makeButton("Rotate -90 (Q)", () => {
      yawIndex -= 1;
      syncHud();
    });
    const rotateRightButton = makeButton("Rotate +90 (E)", () => {
      yawIndex += 1;
      syncHud();
    });
    const resetViewButton = makeButton("Reset View", () => {
      yawIndex = 0;
      zoomTarget = 1.15;
      cameraTarget.set(0, 0, 0);
      syncHud();
    });
    cameraRow.append(rotateLeftButton, rotateRightButton, resetViewButton);

    const utilityRow = makeRow("Scene");
    const clearStructuresButton = makeButton("Clear Walls (C)", () => {
      structureSegments.clear();
      needsRebuild = true;
      syncHud();
    });
    const clearGroundButton = makeButton("Clear Grass (V)", () => {
      groundOverrides.clear();
      needsRebuild = true;
      syncHud();
    });
    utilityRow.append(clearStructuresButton, clearGroundButton);

    const stats = document.createElement("div");
    stats.style.fontSize = "12px";
    stats.style.lineHeight = "1.4";
    stats.style.color = "#c9dceb";
    rightPanel.appendChild(stats);

    const controlsHint = document.createElement("div");
    controlsHint.style.fontSize = "12px";
    controlsHint.style.lineHeight = "1.35";
    controlsHint.style.opacity = "0.92";
    controlsHint.textContent =
      "LMB drag: paint  •  RMB drag: erase  •  MMB or Space+drag: pan  •  Wheel: zoom (mouse), pan (trackpad)";
    rightPanel.appendChild(controlsHint);

    function syncHud(): void {
      toolButtons.forEach((button, mode) => {
        setButtonActive(button, activeTool === mode);
      });

      brushButtons.forEach((button, brush) => {
        setButtonActive(button, activeBrush === brush);
      });

      const viewStep = (yawIndex % 4 + 4) % 4;
      stats.textContent = [
        `Segments: ${structureSegments.size}`,
        `Junctions: ${intersectionCount}`,
        `Grass Tiles: ${groundOverrides.size}`,
        `View Rotation: ${viewStep} / 4`
      ].join("  •  ");

      const { brush, mode } = getCurrentBrushAndMode();
      hoverMaterial.color.setHex(mode === "erase" ? 0xff7e7e : BRUSH_COLORS[brush]);
    }

    function updateCameraProjection(): void {
      const aspect = viewportWidth / viewportHeight;
      const halfHeight = ORTHO_HEIGHT * 0.5;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    }

    function applyPanByPixels(deltaX: number, deltaY: number): void {
      const worldUnitsPerPixel = ORTHO_HEIGHT / zoomCurrent / viewportHeight;
      panRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      panRight.y = 0;
      panRight.normalize();

      panForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      panForward.y = 0;
      panForward.normalize();

      panWorld.set(0, 0, 0);
      panWorld.addScaledVector(panRight, -deltaX * worldUnitsPerPixel);
      panWorld.addScaledVector(panForward, deltaY * worldUnitsPerPixel);
      cameraTarget.add(panWorld);
      clampPanTarget(cameraTarget);
    }

    function setCameraPose(): void {
      const yawTarget = CAMERA_BASE_YAW + yawIndex * (Math.PI * 0.5);
      yawCurrent = dampAngle(yawCurrent, yawTarget, 0.22);
      zoomCurrent = THREE.MathUtils.lerp(zoomCurrent, zoomTarget, 0.18);

      const horizontal = Math.cos(CAMERA_PITCH);
      const direction = new THREE.Vector3(
        Math.sin(yawCurrent) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yawCurrent) * horizontal
      );

      camera.position.copy(cameraTarget).addScaledVector(direction, CAMERA_DISTANCE);
      camera.lookAt(cameraTarget);
      camera.zoom = zoomCurrent;
      camera.updateProjectionMatrix();
    }

    function getWorldAtClient(clientX: number, clientY: number): THREE.Vector3 | null {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointerNdc, camera);
      const hit = raycaster.ray.intersectPlane(groundPlane, nextWorldPoint);
      if (!hit) {
        return null;
      }
      return hit.clone();
    }

    function pickCellFromWorld(world: THREE.Vector3): GridCell | null {
      const localX = (world.x - GRID_ORIGIN) / TILE_SIZE;
      const localZ = (world.z - GRID_ORIGIN) / TILE_SIZE;

      if (localX < 0 || localX >= GRID_TILES || localZ < 0 || localZ >= GRID_TILES) {
        return null;
      }

      return {
        x: Math.floor(localX),
        z: Math.floor(localZ)
      };
    }

    function pickEdgeFromWorld(world: THREE.Vector3): GridEdge | null {
      const localX = (world.x - GRID_ORIGIN) / TILE_SIZE;
      const localZ = (world.z - GRID_ORIGIN) / TILE_SIZE;

      if (localX < -0.001 || localX > GRID_TILES + 0.001 || localZ < -0.001 || localZ > GRID_TILES + 0.001) {
        return null;
      }

      const clampedX = THREE.MathUtils.clamp(localX, 0, GRID_TILES);
      const clampedZ = THREE.MathUtils.clamp(localZ, 0, GRID_TILES);

      const safeCellX = THREE.MathUtils.clamp(Math.floor(localX), 0, GRID_TILES - 1);
      const safeCellZ = THREE.MathUtils.clamp(Math.floor(localZ), 0, GRID_TILES - 1);

      const lineX = THREE.MathUtils.clamp(Math.round(clampedX), 0, GRID_TILES);
      const lineZ = THREE.MathUtils.clamp(Math.round(clampedZ), 0, GRID_TILES);

      const distanceToVertical = Math.abs(clampedX - lineX);
      const distanceToHorizontal = Math.abs(clampedZ - lineZ);

      if (distanceToVertical <= distanceToHorizontal) {
        return {
          ax: lineX,
          az: safeCellZ,
          bx: lineX,
          bz: safeCellZ + 1
        };
      }

      return {
        ax: safeCellX,
        az: lineZ,
        bx: safeCellX + 1,
        bz: lineZ
      };
    }

    function applyGroundTool(cell: GridCell, mode: ToolMode, brush: GroundTileType): void {
      if (mode === "erase") {
        if (getGroundTypeAtCell(cell.x, cell.z) !== DEFAULT_GROUND) {
          groundOverrides.delete(cellKey(cell.x, cell.z));
          needsRebuild = true;
        }
        return;
      }

      const before = getGroundTypeAtCell(cell.x, cell.z);
      if (before !== brush) {
        setGroundTypeAtCell(cell.x, cell.z, brush);
        needsRebuild = true;
      }
    }

    function applyStructureTool(edge: GridEdge, mode: ToolMode, brush: StructureSegmentType): void {
      const key = edgeKey(edge.ax, edge.az, edge.bx, edge.bz);

      if (mode === "erase") {
        if (structureSegments.delete(key)) {
          needsRebuild = true;
        }
        return;
      }

      const before = structureSegments.get(key);
      if (before !== brush) {
        structureSegments.set(key, brush);
        needsRebuild = true;
      }
    }

    function applyBrushAtWorldPoint(world: THREE.Vector3, mode: ToolMode, brush: BrushType): void {
      if (isGroundBrush(brush)) {
        const cell = pickCellFromWorld(world);
        if (!cell) {
          return;
        }
        applyGroundTool(cell, mode, brush);
        return;
      }

      const edge = pickEdgeFromWorld(world);
      if (!edge) {
        return;
      }
      applyStructureTool(edge, mode, brush);
    }

    function strokeBetween(start: THREE.Vector3, end: THREE.Vector3, mode: ToolMode, brush: BrushType): void {
      const distance = start.distanceTo(end);
      const steps = Math.max(1, Math.ceil(distance / 0.2));
      for (let i = 1; i <= steps; i += 1) {
        strokePoint.lerpVectors(start, end, i / steps);
        applyBrushAtWorldPoint(strokePoint, mode, brush);
      }
    }

    function hideHover(): void {
      edgeHoverMesh.visible = false;
      cellHoverMesh.visible = false;
    }

    function updateHoverFromWorld(world: THREE.Vector3 | null): void {
      if (!world) {
        hideHover();
        return;
      }

      const { brush } = getCurrentBrushAndMode();

      if (isGroundBrush(brush)) {
        const cell = pickCellFromWorld(world);
        if (!cell) {
          hideHover();
          return;
        }

        cellHoverMesh.visible = true;
        edgeHoverMesh.visible = false;
        cellHoverMesh.position.set(toWorldCellX(cell.x), 0.03, toWorldCellZ(cell.z));
        return;
      }

      const edge = pickEdgeFromWorld(world);
      if (!edge) {
        hideHover();
        return;
      }

      edgeHoverMesh.visible = true;
      cellHoverMesh.visible = false;

      const xA = toWorldNodeX(edge.ax);
      const zA = toWorldNodeZ(edge.az);
      const xB = toWorldNodeX(edge.bx);
      const zB = toWorldNodeZ(edge.bz);

      edgeHoverMesh.position.set((xA + xB) * 0.5, 0.03, (zA + zB) * 0.5);
      edgeHoverMesh.rotation.y = edge.az !== edge.bz ? Math.PI * 0.5 : 0;
    }

    function updateCursor(): void {
      if (dragState?.mode === "pan") {
        renderer.domElement.style.cursor = "grabbing";
        return;
      }

      if (spacePressed) {
        renderer.domElement.style.cursor = "grab";
        return;
      }

      const { mode } = getCurrentBrushAndMode();
      renderer.domElement.style.cursor = mode === "erase" ? "not-allowed" : "crosshair";
    }

    function handlePointerDown(event: PointerEvent): void {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
        return;
      }

      renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId);

      const startWorld = getWorldAtClient(event.clientX, event.clientY);
      const shouldPan = event.button === 1 || spacePressed;
      const paintMode: ToolMode = event.button === 2 ? "erase" : activeTool;

      if (shouldPan) {
        dragState = {
          pointerId: event.pointerId,
          mode: "pan",
          paintMode,
          brush: activeBrush,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorldPoint: startWorld
        };
        updateCursor();
        event.preventDefault();
        return;
      }

      if (startWorld) {
        applyBrushAtWorldPoint(startWorld, paintMode, activeBrush);
      }

      dragState = {
        pointerId: event.pointerId,
        mode: "paint",
        paintMode,
        brush: activeBrush,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        lastWorldPoint: startWorld
      };

      updateCursor();
      syncHud();
      event.preventDefault();
    }

    function handlePointerMove(event: PointerEvent): void {
      if (dragState && event.pointerId === dragState.pointerId) {
        if (dragState.mode === "pan") {
          const deltaX = event.clientX - dragState.lastClientX;
          const deltaY = event.clientY - dragState.lastClientY;
          applyPanByPixels(deltaX, deltaY);

          dragState.lastClientX = event.clientX;
          dragState.lastClientY = event.clientY;

          updateHoverFromWorld(getWorldAtClient(event.clientX, event.clientY));
          event.preventDefault();
          return;
        }

        const world = getWorldAtClient(event.clientX, event.clientY);
        if (world) {
          if (dragState.lastWorldPoint) {
            strokeBetween(dragState.lastWorldPoint, world, dragState.paintMode, dragState.brush);
          } else {
            applyBrushAtWorldPoint(world, dragState.paintMode, dragState.brush);
          }
          dragState.lastWorldPoint = world;
        }

        updateHoverFromWorld(world);
        event.preventDefault();
        return;
      }

      updateHoverFromWorld(getWorldAtClient(event.clientX, event.clientY));
    }

    function finishPointer(pointerId: number): void {
      if (dragState && dragState.pointerId === pointerId) {
        dragState = null;
      }
      updateCursor();
      syncHud();
    }

    function handlePointerUp(event: PointerEvent): void {
      finishPointer(event.pointerId);
    }

    function handlePointerCancel(event: PointerEvent): void {
      finishPointer(event.pointerId);
    }

    function isLikelyTrackpad(event: WheelEvent): boolean {
      if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        return false;
      }
      if (Math.abs(event.deltaX) > 0.01) {
        return true;
      }
      return Math.abs(event.deltaY) < 24;
    }

    function handleWheel(event: WheelEvent): void {
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const trackpad = isLikelyTrackpad(event);
      const zoomIntent = event.ctrlKey || event.metaKey || !trackpad;

      if (zoomIntent) {
        const delta = event.deltaY * scale;
        zoomTarget = THREE.MathUtils.clamp(zoomTarget * Math.exp(-delta * 0.0015), ZOOM_MIN, ZOOM_MAX);
      } else {
        const panX = (event.deltaX + (event.shiftKey ? event.deltaY : 0)) * scale;
        const panY = event.deltaY * scale;
        applyPanByPixels(panX, panY);
      }

      event.preventDefault();
    }

    function handleContextMenu(event: MouseEvent): void {
      event.preventDefault();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.code === "Space") {
        spacePressed = true;
        updateCursor();
        event.preventDefault();
        return;
      }

      if (event.repeat) {
        return;
      }

      if (event.code === "KeyQ") {
        yawIndex -= 1;
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyE") {
        yawIndex += 1;
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit1") {
        activeBrush = "wall";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit2") {
        activeBrush = "window";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit3") {
        activeBrush = "door";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit4") {
        activeBrush = "floor";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit5") {
        activeBrush = "grass";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyD") {
        activeTool = "draw";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyX") {
        activeTool = "erase";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyC") {
        structureSegments.clear();
        needsRebuild = true;
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyV") {
        groundOverrides.clear();
        needsRebuild = true;
        syncHud();
        event.preventDefault();
      }
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (event.code === "Space") {
        spacePressed = false;
        updateCursor();
        event.preventDefault();
      }
    }

    function syncSize(): void {
      const rect = mount.getBoundingClientRect();
      viewportWidth = Math.max(1, Math.floor(rect.width));
      viewportHeight = Math.max(1, Math.floor(rect.height));

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(viewportWidth, viewportHeight, true);
      updateCameraProjection();
    }

    const resizeObserver = new ResizeObserver(() => {
      syncSize();
    });
    resizeObserver.observe(mount);

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    renderer.domElement.addEventListener("keydown", handleKeyDown);
    renderer.domElement.addEventListener("keyup", handleKeyUp);

    updateCameraProjection();
    syncHud();
    updateCursor();

    const render = () => {
      if (needsRebuild) {
        rebuildGroundTiles();
        rebuildStructures();
        needsRebuild = false;
        syncHud();
      }

      setCameraPose();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();

      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      renderer.domElement.removeEventListener("keydown", handleKeyDown);
      renderer.domElement.removeEventListener("keyup", handleKeyUp);

      if (hud.parentElement) {
        hud.parentElement.removeChild(hud);
      }

      clearGroup(groundGroup);
      clearGroup(structuresGroup);
      clearGroup(jointsGroup);

      groundTileGeometry.dispose();
      segmentGeometry.dispose();
      jointGeometry.dispose();
      edgeHoverGeometry.dispose();
      cellHoverGeometry.dispose();

      floorBaseGeometry.dispose();
      floorBaseMaterial.dispose();
      minorGridGeometry.dispose();
      majorGridGeometry.dispose();
      (minorGrid.material as THREE.Material).dispose();
      (majorGrid.material as THREE.Material).dispose();

      groundFloorMaterial.dispose();
      groundGrassMaterial.dispose();
      structureMaterials.wall.dispose();
      structureMaterials.window.dispose();
      structureMaterials.door.dispose();
      jointMaterial.dispose();
      hoverMaterial.dispose();

      renderer.dispose();
      renderer.domElement.remove();
      mount.style.position = "";
    };
  }
};

export default experiment;
