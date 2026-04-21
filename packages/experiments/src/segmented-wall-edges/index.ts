import * as THREE from "three";
import { PixelPerfectView } from "@common/render";
import { bindPixelPerfectViewInput } from "@common/input";
import type { ExperimentModule } from "../runtime/types";
import { buildWallSegmentSpecs, type WallSegmentSpec } from "./wall-segments";

const SEGMENT_COUNT = 3;
const WALL_LENGTH = 1;
const WALL_HEIGHT = 2.1875;
const WALL_DEPTH = 0.25;
const EDGE_PIXEL_COLOR = "#1d2422";

const VERTEX_SHADER = `
varying vec3 vWorldNormal;

void main() {
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
uniform vec3 uBaseColor;

varying vec3 vWorldNormal;

void main() {
  vec3 n = normalize(vWorldNormal);
  vec3 keyDir = normalize(vec3(-0.45, 0.85, 0.35));
  float key = max(dot(n, keyDir), 0.0);
  float hemi = 0.55 + 0.45 * max(n.y, 0.0);
  vec3 faceTint = uBaseColor * (0.42 + 0.38 * hemi + 0.34 * key);
  gl_FragColor = vec4(faceTint, 1.0);
}
`;

type WorldPoint = { x: number; y: number; z: number };
type ScreenPoint = { x: number; y: number };

type SegmentDebug = {
  index: number;
  suppressMinX: boolean;
  suppressMaxX: boolean;
  center: WorldPoint;
};

type WallEdge = {
  id: string;
  a: WorldPoint;
  b: WorldPoint;
  normals: THREE.Vector3[];
};

declare global {
  interface Window {
    __segmentedWallEdgesDebug?: {
      segments: SegmentDebug[];
      internalJoinWorldPoints: WorldPoint[];
      exteriorEdgeWorldPoints: WorldPoint[];
      projectWorldPoint: (point: WorldPoint) => ScreenPoint | null;
      projectJoinPoints: () => Array<{ x: number; y: number } | null>;
      projectVisibleEdges: () => Array<{ id: string; a: ScreenPoint; b: ScreenPoint }>;
      edgePixelScale: () => number;
      lowTargetSamples: () => number | undefined;
      viewState: () => ReturnType<PixelPerfectView["getState"]>;
    };
  }
}

const FACE_NORMALS = {
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0)
};

function point(x: number, y: number, z: number): WorldPoint {
  return { x, y, z };
}

function createContinuousWallEdges(): WallEdge[] {
  const x0 = -((SEGMENT_COUNT * WALL_LENGTH) / 2);
  const x1 = (SEGMENT_COUNT * WALL_LENGTH) / 2;
  const y0 = 0;
  const y1 = WALL_HEIGHT;
  const z0 = -WALL_DEPTH / 2;
  const z1 = WALL_DEPTH / 2;

  return [
    { id: "top-front", a: point(x0, y1, z1), b: point(x1, y1, z1), normals: [FACE_NORMALS.top, FACE_NORMALS.front] },
    { id: "top-back", a: point(x0, y1, z0), b: point(x1, y1, z0), normals: [FACE_NORMALS.top, FACE_NORMALS.back] },
    { id: "bottom-front", a: point(x0, y0, z1), b: point(x1, y0, z1), normals: [FACE_NORMALS.bottom, FACE_NORMALS.front] },
    { id: "bottom-back", a: point(x0, y0, z0), b: point(x1, y0, z0), normals: [FACE_NORMALS.bottom, FACE_NORMALS.back] },
    { id: "left-front", a: point(x0, y0, z1), b: point(x0, y1, z1), normals: [FACE_NORMALS.left, FACE_NORMALS.front] },
    { id: "left-back", a: point(x0, y0, z0), b: point(x0, y1, z0), normals: [FACE_NORMALS.left, FACE_NORMALS.back] },
    { id: "right-front", a: point(x1, y0, z1), b: point(x1, y1, z1), normals: [FACE_NORMALS.right, FACE_NORMALS.front] },
    { id: "right-back", a: point(x1, y0, z0), b: point(x1, y1, z0), normals: [FACE_NORMALS.right, FACE_NORMALS.back] },
    { id: "top-left", a: point(x0, y1, z0), b: point(x0, y1, z1), normals: [FACE_NORMALS.top, FACE_NORMALS.left] },
    { id: "top-right", a: point(x1, y1, z0), b: point(x1, y1, z1), normals: [FACE_NORMALS.top, FACE_NORMALS.right] },
    { id: "bottom-left", a: point(x0, y0, z0), b: point(x0, y0, z1), normals: [FACE_NORMALS.bottom, FACE_NORMALS.left] },
    { id: "bottom-right", a: point(x1, y0, z0), b: point(x1, y0, z1), normals: [FACE_NORMALS.bottom, FACE_NORMALS.right] }
  ];
}

function addQuad(
  positions: number[],
  normals: number[],
  indices: number[],
  normal: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number]
): void {
  const base = positions.length / 3;
  for (const point of [a, b, c, d]) {
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function createWallSegmentGeometry(spec: WallSegmentSpec): THREE.BufferGeometry {
  const hx = WALL_LENGTH / 2;
  const hz = WALL_DEPTH / 2;
  const y0 = 0;
  const y1 = WALL_HEIGHT;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  addQuad(positions, normals, indices, [0, 0, 1], [-hx, y0, hz], [hx, y0, hz], [hx, y1, hz], [-hx, y1, hz]);
  addQuad(positions, normals, indices, [0, 0, -1], [hx, y0, -hz], [-hx, y0, -hz], [-hx, y1, -hz], [hx, y1, -hz]);
  addQuad(positions, normals, indices, [0, 1, 0], [-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz], [-hx, y1, -hz]);
  addQuad(positions, normals, indices, [0, -1, 0], [-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]);

  if (!spec.suppressMinX) {
    addQuad(positions, normals, indices, [-1, 0, 0], [-hx, y0, -hz], [-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz]);
  }
  if (!spec.suppressMaxX) {
    addQuad(positions, normals, indices, [1, 0, 0], [hx, y0, hz], [hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createWallMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(0xb98f5a) }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER
  });
}

function createWallSegments(): {
  root: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  debugSegments: SegmentDebug[];
} {
  const root = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const debugSegments: SegmentDebug[] = [];

  for (const spec of buildWallSegmentSpecs(SEGMENT_COUNT, WALL_LENGTH)) {
    const geometry = createWallSegmentGeometry(spec);
    const material = createWallMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(spec.centerX, 0, 0);
    mesh.name = `wall-segment-${spec.index}`;
    root.add(mesh);
    geometries.push(geometry);
    materials.push(material);
    debugSegments.push({
      index: spec.index,
      suppressMinX: spec.suppressMinX,
      suppressMaxX: spec.suppressMaxX,
      center: { x: spec.centerX, y: 0, z: 0 }
    });
  }

  return { root, geometries, materials, debugSegments };
}

function createGround(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(5.2, 3.2);
  const material = new THREE.MeshBasicMaterial({ color: 0x748078 });
  const ground = new THREE.Mesh(geometry, material);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.002, 0);
  return ground;
}

function createHud(mount: HTMLElement): HTMLDivElement {
  const hud = document.createElement("div");
  hud.textContent = "Middle drag pan | Wheel zoom | Q/E rotate";
  hud.style.position = "absolute";
  hud.style.left = "10px";
  hud.style.bottom = "10px";
  hud.style.padding = "5px 8px";
  hud.style.color = "#d8e0e6";
  hud.style.background = "rgba(10, 13, 16, 0.72)";
  hud.style.borderRadius = "4px";
  hud.style.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  hud.style.pointerEvents = "none";
  hud.style.zIndex = "3";
  mount.appendChild(hud);
  return hud;
}

function syncOverlayCanvasToRenderer(canvas: HTMLCanvasElement, rendererCanvas: HTMLCanvasElement): void {
  if (canvas.width !== rendererCanvas.width || canvas.height !== rendererCanvas.height) {
    canvas.width = rendererCanvas.width;
    canvas.height = rendererCanvas.height;
  }
  canvas.style.left = rendererCanvas.style.left;
  canvas.style.top = rendererCanvas.style.top;
  canvas.style.width = rendererCanvas.style.width;
  canvas.style.height = rendererCanvas.style.height;
}

function createPixelOverlay(mount: HTMLElement, rendererCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.imageRendering = "pixelated";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "2";
  syncOverlayCanvasToRenderer(canvas, rendererCanvas);
  mount.appendChild(canvas);
  return canvas;
}

function isVisibleEdge(edge: WallEdge, cameraDirection: THREE.Vector3): boolean {
  return edge.normals.some((normal) => normal.dot(cameraDirection) < -0.0001);
}

function edgePixelScaleForView(view: PixelPerfectView): number {
  const state = view.getState();
  return Math.max(1, Math.round(state.baseRenderScale * Math.max(1, state.cameraZoomCurrent)));
}

function drawPixel(ctx: CanvasRenderingContext2D, x: number, y: number, pixelScale: number): void {
  ctx.fillRect(x * pixelScale, y * pixelScale, pixelScale, pixelScale);
}

function drawTwoToOneHorizontal(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  sx: number,
  sy: number,
  dy: number,
  pixelScale: number
): void {
  for (let row = 0; row <= dy; row += 1) {
    const y = y0 + sy * row;
    const x = x0 + sx * row * 2;
    drawPixel(ctx, x, y, pixelScale);
    drawPixel(ctx, x + sx, y, pixelScale);
  }
}

function drawTwoToOneVertical(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  sx: number,
  sy: number,
  dx: number,
  pixelScale: number
): void {
  for (let column = 0; column <= dx; column += 1) {
    const x = x0 + sx * column;
    const y = y0 + sy * column * 2;
    drawPixel(ctx, x, y, pixelScale);
    drawPixel(ctx, x, y + sy, pixelScale);
  }
}

function drawDdaLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pixelScale: number
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) {
    drawPixel(ctx, x0, y0, pixelScale);
    return;
  }
  for (let i = 0; i <= steps; i += 1) {
    drawPixel(
      ctx,
      Math.round(x0 + (dx * i) / steps),
      Math.round(y0 + (dy * i) / steps),
      pixelScale
    );
  }
}

function drawPixelLine(ctx: CanvasRenderingContext2D, a: ScreenPoint, b: ScreenPoint, pixelScale: number): void {
  const x0 = Math.round(a.x / pixelScale);
  const y0 = Math.round(a.y / pixelScale);
  const x1 = Math.round(b.x / pixelScale);
  const y1 = Math.round(b.y / pixelScale);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = Math.sign(x1 - x0) || 1;
  const sy = Math.sign(y1 - y0) || 1;

  if (dx >= dy && dy > 0 && Math.abs(dx - dy * 2) <= 2) {
    drawTwoToOneHorizontal(ctx, x0, y0, sx, sy, dy, pixelScale);
    return;
  }
  if (dy > dx && dx > 0 && Math.abs(dy - dx * 2) <= 2) {
    drawTwoToOneVertical(ctx, x0, y0, sx, sy, dx, pixelScale);
    return;
  }

  drawDdaLine(ctx, x0, y0, x1, y1, pixelScale);
}

function projectEdgeToLocal(
  edge: WallEdge,
  view: PixelPerfectView,
  mountRect: DOMRect
): { id: string; a: ScreenPoint; b: ScreenPoint } | null {
  const a = new THREE.Vector2();
  const b = new THREE.Vector2();
  if (
    !view.projectWorldToClient(new THREE.Vector3(edge.a.x, edge.a.y, edge.a.z), a) ||
    !view.projectWorldToClient(new THREE.Vector3(edge.b.x, edge.b.y, edge.b.z), b)
  ) {
    return null;
  }
  return {
    id: edge.id,
    a: { x: a.x - mountRect.left, y: a.y - mountRect.top },
    b: { x: b.x - mountRect.left, y: b.y - mountRect.top }
  };
}

function projectVisibleEdges(
  edges: WallEdge[],
  view: PixelPerfectView,
  overlay: HTMLCanvasElement,
  cameraDirection: THREE.Vector3
): Array<{ id: string; a: ScreenPoint; b: ScreenPoint }> {
  const mountRect = overlay.getBoundingClientRect();
  const projected: Array<{ id: string; a: ScreenPoint; b: ScreenPoint }> = [];
  for (const edge of edges) {
    if (!isVisibleEdge(edge, cameraDirection)) continue;
    const line = projectEdgeToLocal(edge, view, mountRect);
    if (line) projected.push(line);
  }
  return projected;
}

function drawEdgeOverlay(
  overlay: HTMLCanvasElement,
  edges: WallEdge[],
  view: PixelPerfectView,
  rendererCanvas: HTMLCanvasElement,
  cameraDirection: THREE.Vector3
): void {
  syncOverlayCanvasToRenderer(overlay, rendererCanvas);
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.fillStyle = EDGE_PIXEL_COLOR;
  const pixelScale = edgePixelScaleForView(view);
  for (const edge of projectVisibleEdges(edges, view, overlay, cameraDirection)) {
    drawPixelLine(ctx, edge.a, edge.b, pixelScale);
  }
}

const experiment: ExperimentModule = {
  id: "segmented-wall-edges",
  title: "Segmented Wall Edges",
  tags: ["threejs", "pixel-perfect", "isometric", "shader"],

  init: ({ mount, width, height }) => {
    mount.style.position = "relative";

    const scene = new THREE.Scene();
    const ground = createGround();
    scene.add(ground);

    const { root, geometries, materials, debugSegments } = createWallSegments();
    scene.add(root);

    const view = new PixelPerfectView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: 240,
      baseOrthoHeight: 7.0,
      cameraDistance: 24,
      cameraPitch: "iso-2to1",
      cameraYaw: Math.PI / 4,
      verticalBias: 0.44,
      basePixelZoom: 2,
      zoomMin: 1,
      zoomMax: 6,
      zoomStep: 1,
      zoomAnimationRate: 14,
      zoomAnimationBurstRate: 42,
      zoomAnimationEpsilon: 0.001,
      rotationAnimationRate: 18,
      rotationAnimationEpsilon: 0.001,
      zoomBurstIdleMs: 200,
      outputOverscanLowPixels: 2,
      lowTargetSamples: 0,
      clearColor: 0xa6afa7,
      clearAlpha: 1,
      mountBackground: "#a6afa7",
      canvasBackground: "#a6afa7"
    });
    view.setViewPose({ ...view.getViewPose(), targetX: 0, targetZ: 0, zoom: 2 });

    const unbindInput = bindPixelPerfectViewInput({ view });
    const overlay = createPixelOverlay(mount, view.canvas);
    const hud = createHud(mount);
    const continuousEdges = createContinuousWallEdges();
    const cameraDirection = new THREE.Vector3();

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: nextWidth, height: nextHeight } = entry.contentRect;
        if (nextWidth > 0 && nextHeight > 0) {
          view.resize(nextWidth, nextHeight);
          syncOverlayCanvasToRenderer(overlay, view.canvas);
        }
      }
    });
    resizeObserver.observe(mount);

    const internalJoinWorldPoints = [-0.5, 0.5].map((x) => ({
      x,
      y: WALL_HEIGHT * 0.72,
      z: WALL_DEPTH / 2
    }));
    const exteriorEdgeWorldPoints = [-1.5, 1.5].map((x) => ({
      x,
      y: WALL_HEIGHT * 0.72,
      z: WALL_DEPTH / 2
    }));
    const projected = new THREE.Vector2();
    const projectWorldPoint = (point: { x: number; y: number; z: number }) => {
      const ok = view.projectWorldToClient(new THREE.Vector3(point.x, point.y, point.z), projected);
      return ok ? { x: projected.x, y: projected.y } : null;
    };
    window.__segmentedWallEdgesDebug = {
      segments: debugSegments,
      internalJoinWorldPoints,
      exteriorEdgeWorldPoints,
      projectWorldPoint,
      projectJoinPoints: () => internalJoinWorldPoints.map(projectWorldPoint),
      projectVisibleEdges: () => {
        view.camera.getWorldDirection(cameraDirection);
        return projectVisibleEdges(continuousEdges, view, overlay, cameraDirection);
      },
      edgePixelScale: () => edgePixelScaleForView(view),
      lowTargetSamples: () => view.getLowTarget().samples,
      viewState: () => view.getState()
    };

    let raf = 0;
    let prevTime = performance.now();
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - prevTime) / 1000, 0.1);
      prevTime = now;
      view.frame(now, dt);
      view.camera.getWorldDirection(cameraDirection);
      drawEdgeOverlay(overlay, continuousEdges, view, view.canvas, cameraDirection);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      unbindInput();
      overlay.remove();
      hud.remove();
      delete window.__segmentedWallEdgesDebug;
      scene.remove(root, ground);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      ground.geometry.dispose();
      if (Array.isArray(ground.material)) {
        for (const material of ground.material) material.dispose();
      } else {
        ground.material.dispose();
      }
      view.dispose();
    };
  }
};

export default experiment;
