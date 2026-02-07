import * as THREE from "three";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

type SegmentType = "wall" | "window" | "door";
type ToolMode = "draw" | "erase";

type GridEdge = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
};

type DirectionVector = {
  dx: number;
  dz: number;
};

type DragState = {
  pointerId: number;
  mode: "paint" | "pan";
  toolOverride: ToolMode | null;
  lastClientX: number;
  lastClientY: number;
  lastWorldPoint: THREE.Vector3 | null;
};

const GRID_TILES = 30;
const TILE_SIZE = 1;
const GRID_ORIGIN = -(GRID_TILES * TILE_SIZE) * 0.5;

const WALL_HEIGHT = 2.8;
const WALL_THICKNESS = 0.18;

const ORTHO_HEIGHT = 28;
const CAMERA_DISTANCE = 34;
const CAMERA_PITCH = THREE.MathUtils.degToRad(35.26438968);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 3.8;
const PAN_CLAMP = GRID_TILES * 0.8;

const BRUSH_COLORS: Record<SegmentType, number> = {
  wall: 0xbec7d0,
  window: 0x8ccdee,
  door: 0xd9b17f
};

function nodeKey(x: number, z: number): string {
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

    const floorGeometry = new THREE.PlaneGeometry(GRID_TILES * TILE_SIZE, GRID_TILES * TILE_SIZE);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a2c39,
      roughness: 0.94,
      metalness: 0.02
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI * 0.5;
    scene.add(floor);

    const minorGridGeometry = createGridGeometry(1, 0.001);
    const majorGridGeometry = createGridGeometry(5, 0.002);
    const minorGrid = new THREE.LineSegments(
      minorGridGeometry,
      new THREE.LineBasicMaterial({ color: 0x375069, transparent: true, opacity: 0.45 })
    );
    const majorGrid = new THREE.LineSegments(
      majorGridGeometry,
      new THREE.LineBasicMaterial({ color: 0x5d7f9d, transparent: true, opacity: 0.7 })
    );
    scene.add(minorGrid);
    scene.add(majorGrid);

    const structuresGroup = new THREE.Group();
    const jointsGroup = new THREE.Group();
    scene.add(structuresGroup);
    scene.add(jointsGroup);

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: BRUSH_COLORS.wall,
      roughness: 0.6,
      metalness: 0.03
    });
    const windowFrameMaterial = new THREE.MeshStandardMaterial({
      color: BRUSH_COLORS.window,
      roughness: 0.54,
      metalness: 0.07
    });
    const windowGlassMaterial = new THREE.MeshStandardMaterial({
      color: 0xa2dfff,
      roughness: 0.2,
      metalness: 0.0,
      transparent: true,
      opacity: 0.4
    });
    const doorFrameMaterial = new THREE.MeshStandardMaterial({
      color: BRUSH_COLORS.door,
      roughness: 0.62,
      metalness: 0.04
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0xf0dca8,
      roughness: 0.5,
      metalness: 0.1
    });
    const jointCapMaterial = new THREE.MeshStandardMaterial({
      color: 0xffeecc,
      roughness: 0.35,
      metalness: 0.25
    });
    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: BRUSH_COLORS.wall,
      transparent: true,
      opacity: 0.68,
      depthWrite: false
    });

    const fullWallGeometry = new THREE.BoxGeometry(TILE_SIZE, WALL_HEIGHT, WALL_THICKNESS);
    const windowSillGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.9, WALL_THICKNESS);
    const windowLintelGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.7, WALL_THICKNESS);
    const windowPostGeometry = new THREE.BoxGeometry(0.16, 1.2, WALL_THICKNESS);
    const windowGlassGeometry = new THREE.PlaneGeometry(0.66, 1.12);

    const doorJambGeometry = new THREE.BoxGeometry(0.14, WALL_HEIGHT, WALL_THICKNESS);
    const doorLintelGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.34, WALL_THICKNESS);
    const doorThresholdGeometry = new THREE.BoxGeometry(TILE_SIZE * 0.92, 0.07, WALL_THICKNESS * 0.82);

    const jointPostGeometry = new THREE.BoxGeometry(0.22, WALL_HEIGHT, 0.22);
    const jointArmXGeometry = new THREE.BoxGeometry(0.4, 0.14, 0.14);
    const jointArmZGeometry = new THREE.BoxGeometry(0.14, 0.14, 0.4);
    const jointCapGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.08, 10);

    const hoverGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.05, WALL_THICKNESS);
    const hoverMesh = new THREE.Mesh(hoverGeometry, hoverMaterial);
    hoverMesh.visible = false;
    hoverMesh.position.y = 0.03;
    scene.add(hoverMesh);

    const wallSegments = new Map<string, SegmentType>();

    let activeBrush: SegmentType = "wall";
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
    leftPanel.style.width = "min(320px, 46vw)";
    hud.appendChild(leftPanel);

    const rightPanel = document.createElement("div");
    panelStyle(rightPanel);
    rightPanel.style.minWidth = "180px";
    rightPanel.style.alignItems = "stretch";
    hud.appendChild(rightPanel);

    const title = document.createElement("div");
    title.textContent = "Level Builder";
    title.style.fontWeight = "600";
    title.style.letterSpacing = "0.02em";
    leftPanel.appendChild(title);

    const helper = document.createElement("div");
    helper.textContent = "Smart joins are generated automatically for corners, T-junctions, and crosses.";
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

    const toolButtons = new Map<ToolMode, HTMLButtonElement>();
    const brushButtons = new Map<SegmentType, HTMLButtonElement>();

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
    brushButtons.set("wall", wallBrushButton);
    brushButtons.set("window", windowBrushButton);
    brushButtons.set("door", doorBrushButton);
    brushRow.append(wallBrushButton, windowBrushButton, doorBrushButton);

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
    const clearButton = makeButton("Clear Layout", () => {
      wallSegments.clear();
      needsRebuild = true;
      syncHud();
    });
    utilityRow.append(clearButton);

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
      "LMB drag: draw/erase  •  RMB drag: quick erase  •  MMB or Space+drag: pan  •  Wheel: zoom (mouse), pan (trackpad)";
    rightPanel.appendChild(controlsHint);

    function syncHud(): void {
      toolButtons.forEach((button, mode) => {
        setButtonActive(button, activeTool === mode);
      });

      brushButtons.forEach((button, brush) => {
        setButtonActive(button, activeBrush === brush);
      });

      stats.textContent = [
        `Segments: ${wallSegments.size}`,
        `Intersections: ${intersectionCount}`,
        `View Rotation: ${(yawIndex % 4 + 4) % 4} / 4`
      ].join("  •  ");

      const toolForHover = dragState?.toolOverride ?? activeTool;
      if (toolForHover === "erase") {
        hoverMaterial.color.setHex(0xff7e7e);
      } else {
        hoverMaterial.color.setHex(BRUSH_COLORS[activeBrush]);
      }
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

    function clearGroup(group: THREE.Group): void {
      for (let i = group.children.length - 1; i >= 0; i -= 1) {
        group.remove(group.children[i]);
      }
    }

    function createWallSegment(type: SegmentType): THREE.Object3D {
      if (type === "wall") {
        const mesh = new THREE.Mesh(fullWallGeometry, wallMaterial);
        mesh.position.y = WALL_HEIGHT * 0.5;
        return mesh;
      }

      if (type === "window") {
        const group = new THREE.Group();

        const sill = new THREE.Mesh(windowSillGeometry, windowFrameMaterial);
        sill.position.y = 0.45;
        group.add(sill);

        const lintel = new THREE.Mesh(windowLintelGeometry, windowFrameMaterial);
        lintel.position.y = 2.45;
        group.add(lintel);

        const leftPost = new THREE.Mesh(windowPostGeometry, windowFrameMaterial);
        leftPost.position.set(-0.42, 1.5, 0);
        group.add(leftPost);

        const rightPost = new THREE.Mesh(windowPostGeometry, windowFrameMaterial);
        rightPost.position.set(0.42, 1.5, 0);
        group.add(rightPost);

        const glass = new THREE.Mesh(windowGlassGeometry, windowGlassMaterial);
        glass.position.y = 1.5;
        glass.position.z = 0.015;
        group.add(glass);

        return group;
      }

      const group = new THREE.Group();

      const leftJamb = new THREE.Mesh(doorJambGeometry, doorFrameMaterial);
      leftJamb.position.set(-0.43, WALL_HEIGHT * 0.5, 0);
      group.add(leftJamb);

      const rightJamb = new THREE.Mesh(doorJambGeometry, doorFrameMaterial);
      rightJamb.position.set(0.43, WALL_HEIGHT * 0.5, 0);
      group.add(rightJamb);

      const lintel = new THREE.Mesh(doorLintelGeometry, doorFrameMaterial);
      lintel.position.y = 2.62;
      group.add(lintel);

      const threshold = new THREE.Mesh(doorThresholdGeometry, doorFrameMaterial);
      threshold.position.y = 0.035;
      group.add(threshold);

      return group;
    }

    function createJoint(directions: DirectionVector[]): THREE.Object3D {
      const degree = directions.length;
      const post = new THREE.Mesh(jointPostGeometry, jointMaterial);
      const postScale = 0.95 + degree * 0.14;
      post.scale.x = postScale;
      post.scale.z = postScale;
      post.position.y = WALL_HEIGHT * 0.5;

      const group = new THREE.Group();
      group.add(post);

      for (const direction of directions) {
        if (direction.dx !== 0) {
          const arm = new THREE.Mesh(jointArmXGeometry, jointMaterial);
          arm.position.set(direction.dx * 0.25, 1.72, 0);
          group.add(arm);
        }

        if (direction.dz !== 0) {
          const arm = new THREE.Mesh(jointArmZGeometry, jointMaterial);
          arm.position.set(0, 1.72, direction.dz * 0.25);
          group.add(arm);
        }
      }

      const cap = new THREE.Mesh(jointCapGeometry, jointCapMaterial);
      const capScale = 0.82 + degree * 0.12;
      cap.scale.set(capScale, 1, capScale);
      cap.position.y = WALL_HEIGHT + 0.04;
      group.add(cap);

      return group;
    }

    function registerDirection(map: Map<string, DirectionVector[]>, x: number, z: number, dx: number, dz: number): void {
      const key = nodeKey(x, z);
      const next = map.get(key) ?? [];
      if (!next.some((entry) => entry.dx === dx && entry.dz === dz)) {
        next.push({ dx, dz });
      }
      map.set(key, next);
    }

    function rebuildStructures(): void {
      clearGroup(structuresGroup);
      clearGroup(jointsGroup);

      const adjacency = new Map<string, DirectionVector[]>();
      intersectionCount = 0;

      wallSegments.forEach((segmentType, segmentKey) => {
        const edge = parseEdge(segmentKey);
        const module = createWallSegment(segmentType);

        const xA = toWorldNodeX(edge.ax);
        const zA = toWorldNodeZ(edge.az);
        const xB = toWorldNodeX(edge.bx);
        const zB = toWorldNodeZ(edge.bz);

        module.position.set((xA + xB) * 0.5, 0, (zA + zB) * 0.5);
        if (edge.az !== edge.bz) {
          module.rotation.y = Math.PI * 0.5;
        }
        structuresGroup.add(module);

        registerDirection(adjacency, edge.ax, edge.az, edge.bx - edge.ax, edge.bz - edge.az);
        registerDirection(adjacency, edge.bx, edge.bz, edge.ax - edge.bx, edge.az - edge.bz);
      });

      adjacency.forEach((directions, key) => {
        const [xRaw, zRaw] = key.split(",");
        const nodeX = Number(xRaw);
        const nodeZ = Number(zRaw);
        const joint = createJoint(directions);
        joint.position.set(toWorldNodeX(nodeX), 0, toWorldNodeZ(nodeZ));
        jointsGroup.add(joint);

        if (directions.length >= 2) {
          intersectionCount += 1;
        }
      });

      syncHud();
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

    function applyToolToEdge(edge: GridEdge, mode: ToolMode): void {
      const key = edgeKey(edge.ax, edge.az, edge.bx, edge.bz);
      if (mode === "erase") {
        if (wallSegments.delete(key)) {
          needsRebuild = true;
        }
        return;
      }

      const previous = wallSegments.get(key);
      if (previous !== activeBrush) {
        wallSegments.set(key, activeBrush);
        needsRebuild = true;
      }
    }

    function paintAtWorldPoint(world: THREE.Vector3, mode: ToolMode): void {
      const edge = pickEdgeFromWorld(world);
      if (!edge) {
        return;
      }
      applyToolToEdge(edge, mode);
    }

    function strokeBetween(start: THREE.Vector3, end: THREE.Vector3, mode: ToolMode): void {
      const distance = start.distanceTo(end);
      const steps = Math.max(1, Math.ceil(distance / 0.2));
      for (let i = 1; i <= steps; i += 1) {
        strokePoint.lerpVectors(start, end, i / steps);
        paintAtWorldPoint(strokePoint, mode);
      }
    }

    function updateHover(edge: GridEdge | null): void {
      if (!edge) {
        hoverMesh.visible = false;
        return;
      }

      const xA = toWorldNodeX(edge.ax);
      const zA = toWorldNodeZ(edge.az);
      const xB = toWorldNodeX(edge.bx);
      const zB = toWorldNodeZ(edge.bz);

      hoverMesh.visible = true;
      hoverMesh.position.set((xA + xB) * 0.5, 0.03, (zA + zB) * 0.5);
      hoverMesh.rotation.y = edge.az !== edge.bz ? Math.PI * 0.5 : 0;
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

      if ((dragState?.toolOverride ?? activeTool) === "erase") {
        renderer.domElement.style.cursor = "not-allowed";
      } else {
        renderer.domElement.style.cursor = "crosshair";
      }
    }

    function handlePointerDown(event: PointerEvent): void {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
        return;
      }

      renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId);

      const startWorld = getWorldAtClient(event.clientX, event.clientY);
      const shouldPan = event.button === 1 || spacePressed;
      const quickErase = event.button === 2;

      if (shouldPan) {
        dragState = {
          pointerId: event.pointerId,
          mode: "pan",
          toolOverride: null,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorldPoint: startWorld
        };
        updateCursor();
        event.preventDefault();
        return;
      }

      const mode = quickErase ? "erase" : activeTool;
      if (startWorld) {
        paintAtWorldPoint(startWorld, mode);
      }

      dragState = {
        pointerId: event.pointerId,
        mode: "paint",
        toolOverride: quickErase ? "erase" : null,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        lastWorldPoint: startWorld
      };
      updateCursor();
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

          const hoverWorld = getWorldAtClient(event.clientX, event.clientY);
          updateHover(hoverWorld ? pickEdgeFromWorld(hoverWorld) : null);
          event.preventDefault();
          return;
        }

        const world = getWorldAtClient(event.clientX, event.clientY);
        if (world) {
          const mode = dragState.toolOverride ?? activeTool;
          if (dragState.lastWorldPoint) {
            strokeBetween(dragState.lastWorldPoint, world, mode);
          } else {
            paintAtWorldPoint(world, mode);
          }
          dragState.lastWorldPoint = world;
          updateHover(pickEdgeFromWorld(world));
        } else {
          updateHover(null);
        }
        event.preventDefault();
        return;
      }

      const world = getWorldAtClient(event.clientX, event.clientY);
      if (!world) {
        updateHover(null);
        return;
      }
      updateHover(pickEdgeFromWorld(world));
    }

    function finishPointer(pointerId: number): void {
      if (dragState && dragState.pointerId === pointerId) {
        dragState = null;
      }
      updateCursor();
      syncHud();
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
      } else if (event.code === "KeyD") {
        activeTool = "draw";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyX") {
        activeTool = "erase";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyC") {
        wallSegments.clear();
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
      const nextWidth = Math.max(1, Math.floor(rect.width));
      const nextHeight = Math.max(1, Math.floor(rect.height));
      viewportWidth = nextWidth;
      viewportHeight = nextHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(nextWidth, nextHeight, true);
      updateCameraProjection();
    }

    const resizeObserver = new ResizeObserver(() => {
      syncSize();
    });
    resizeObserver.observe(mount);

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", (event) => finishPointer(event.pointerId));
    renderer.domElement.addEventListener("pointercancel", (event) => finishPointer(event.pointerId));
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    renderer.domElement.addEventListener("keydown", handleKeyDown);
    renderer.domElement.addEventListener("keyup", handleKeyUp);

    updateCameraProjection();
    syncHud();
    updateCursor();

    const render = () => {
      if (needsRebuild) {
        rebuildStructures();
        needsRebuild = false;
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
      renderer.domElement.removeEventListener("wheel", handleWheel);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      renderer.domElement.removeEventListener("keydown", handleKeyDown);
      renderer.domElement.removeEventListener("keyup", handleKeyUp);

      if (hud.parentElement) {
        hud.parentElement.removeChild(hud);
      }

      clearGroup(structuresGroup);
      clearGroup(jointsGroup);

      fullWallGeometry.dispose();
      windowSillGeometry.dispose();
      windowLintelGeometry.dispose();
      windowPostGeometry.dispose();
      windowGlassGeometry.dispose();
      doorJambGeometry.dispose();
      doorLintelGeometry.dispose();
      doorThresholdGeometry.dispose();
      jointPostGeometry.dispose();
      jointArmXGeometry.dispose();
      jointArmZGeometry.dispose();
      jointCapGeometry.dispose();
      hoverGeometry.dispose();

      floorGeometry.dispose();
      floorMaterial.dispose();
      minorGridGeometry.dispose();
      majorGridGeometry.dispose();
      (minorGrid.material as THREE.Material).dispose();
      (majorGrid.material as THREE.Material).dispose();
      wallMaterial.dispose();
      windowFrameMaterial.dispose();
      windowGlassMaterial.dispose();
      doorFrameMaterial.dispose();
      jointMaterial.dispose();
      jointCapMaterial.dispose();
      hoverMaterial.dispose();

      renderer.dispose();
      renderer.domElement.remove();
      mount.style.position = "";
    };
  }
};

export default experiment;
