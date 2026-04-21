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

const ID_FRAGMENT_SHADER = `
varying vec3 vWorldNormal;

float categoryForNormal(vec3 n) {
  vec3 an = abs(n);
  if (n.y > 0.5) return 1.0;
  if (an.z > 0.5) return 2.0;
  if (an.x > 0.5) return 3.0;
  return 0.0;
}

void main() {
  float category = categoryForNormal(normalize(vWorldNormal));
  gl_FragColor = vec4(category / 3.0, 0.0, 0.0, 1.0);
}
`;

const POST_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const POST_FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D uColorTex;
uniform sampler2D uIdTex;
uniform vec2 uTexelSize;
uniform vec3 uEdgeColor;

varying vec2 vUv;

float decodeCategory(vec2 uv) {
  return floor(texture2D(uIdTex, uv).r * 3.0 + 0.5);
}

float priorityForCategory(float category) {
  if (category < 0.5) return 0.0;
  if (category < 1.5) return 1.0;
  if (category < 2.5) return 2.0;
  return 3.0;
}

bool shouldShadeAgainst(float currentCategory, vec2 stepOffset) {
  float neighborCategory = decodeCategory(vUv + stepOffset * uTexelSize);
  if (neighborCategory < 0.5) return true;
  if (abs(neighborCategory - currentCategory) <= 0.1) return false;
  return priorityForCategory(currentCategory) > priorityForCategory(neighborCategory);
}

void main() {
  vec4 baseColor = texture2D(uColorTex, vUv);
  float currentCategory = decodeCategory(vUv);
  if (currentCategory < 0.5) {
    gl_FragColor = baseColor;
    return;
  }

  bool edge = false;
  edge = edge || shouldShadeAgainst(currentCategory, vec2(-1.0, 0.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(1.0, 0.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(0.0, -1.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(0.0, 1.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(-1.0, -1.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(1.0, -1.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(-1.0, 1.0));
  edge = edge || shouldShadeAgainst(currentCategory, vec2(1.0, 1.0));

  gl_FragColor = edge ? vec4(uEdgeColor, 1.0) : baseColor;
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

function createWallIdMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: ID_FRAGMENT_SHADER
  });
}

function createWallSegments(): {
  root: THREE.Group;
  idRoot: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  debugSegments: SegmentDebug[];
} {
  const root = new THREE.Group();
  const idRoot = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const debugSegments: SegmentDebug[] = [];

  for (const spec of buildWallSegmentSpecs(SEGMENT_COUNT, WALL_LENGTH)) {
    const geometry = createWallSegmentGeometry(spec);
    const material = createWallMaterial();
    const idMaterial = createWallIdMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    const idMesh = new THREE.Mesh(geometry, idMaterial);
    mesh.position.set(spec.centerX, 0, 0);
    idMesh.position.copy(mesh.position);
    mesh.name = `wall-segment-${spec.index}`;
    idMesh.name = `wall-segment-id-${spec.index}`;
    root.add(mesh);
    idRoot.add(idMesh);
    geometries.push(geometry);
    materials.push(material, idMaterial);
    debugSegments.push({
      index: spec.index,
      suppressMinX: spec.suppressMinX,
      suppressMaxX: spec.suppressMaxX,
      center: { x: spec.centerX, y: 0, z: 0 }
    });
  }

  return { root, idRoot, geometries, materials, debugSegments };
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

function isVisibleEdge(edge: WallEdge, cameraDirection: THREE.Vector3): boolean {
  return edge.normals.some((normal) => normal.dot(cameraDirection) < -0.0001);
}

function edgePixelScaleForView(view: PixelPerfectView): number {
  const state = view.getState();
  return Math.max(1, Math.round(state.baseRenderScale * Math.max(1, state.cameraZoomCurrent)));
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
  mountRect: DOMRect,
  cameraDirection: THREE.Vector3
): Array<{ id: string; a: ScreenPoint; b: ScreenPoint }> {
  const projected: Array<{ id: string; a: ScreenPoint; b: ScreenPoint }> = [];
  for (const edge of edges) {
    if (!isVisibleEdge(edge, cameraDirection)) continue;
    const line = projectEdgeToLocal(edge, view, mountRect);
    if (line) projected.push(line);
  }
  return projected;
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

    const { root, idRoot, geometries, materials, debugSegments } = createWallSegments();
    scene.add(root);
    const idScene = new THREE.Scene();
    idScene.add(idRoot);

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
      smoothPixelTransitions: false,
      clearColor: 0xa6afa7,
      clearAlpha: 1,
      mountBackground: "#a6afa7",
      canvasBackground: "#a6afa7"
    });
    view.setViewPose({ ...view.getViewPose(), targetX: 0, targetZ: 0, zoom: 2 });

    const idTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      samples: 0
    });
    idTarget.texture.generateMipmaps = false;
    const edgeTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      samples: 0
    });
    edgeTarget.texture.generateMipmaps = false;
    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorTex: { value: null as THREE.Texture | null },
        uIdTex: { value: idTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1, 1) },
        uEdgeColor: { value: new THREE.Color(EDGE_PIXEL_COLOR) }
      },
      vertexShader: POST_VERTEX_SHADER,
      fragmentShader: POST_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false
    });
    const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
    postQuad.frustumCulled = false;
    postScene.add(postQuad);
    view.setOutputSourceTexture(edgeTarget.texture);
    view.afterSceneRender = (renderer, lowTarget) => {
      if (idTarget.width !== lowTarget.width || idTarget.height !== lowTarget.height) {
        idTarget.setSize(lowTarget.width, lowTarget.height);
        edgeTarget.setSize(lowTarget.width, lowTarget.height);
        (postMaterial.uniforms.uTexelSize.value as THREE.Vector2).set(
          1 / lowTarget.width,
          1 / lowTarget.height
        );
      }

      renderer.setRenderTarget(idTarget);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, idTarget.width, idTarget.height);
      renderer.setScissor(0, 0, idTarget.width, idTarget.height);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(idScene, view.camera);

      postMaterial.uniforms.uColorTex.value = lowTarget.texture;
      renderer.setRenderTarget(edgeTarget);
      renderer.setViewport(0, 0, edgeTarget.width, edgeTarget.height);
      renderer.setScissor(0, 0, edgeTarget.width, edgeTarget.height);
      renderer.clear();
      renderer.render(postScene, postCamera);
    };

    const unbindInput = bindPixelPerfectViewInput({ view });
    const hud = createHud(mount);
    const continuousEdges = createContinuousWallEdges();
    const cameraDirection = new THREE.Vector3();

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: nextWidth, height: nextHeight } = entry.contentRect;
        if (nextWidth > 0 && nextHeight > 0) {
          view.resize(nextWidth, nextHeight);
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
        return projectVisibleEdges(continuousEdges, view, mount.getBoundingClientRect(), cameraDirection);
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
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      unbindInput();
      hud.remove();
      delete window.__segmentedWallEdgesDebug;
      scene.remove(root, ground);
      idScene.remove(idRoot);
      postScene.remove(postQuad);
      view.afterSceneRender = null;
      view.setOutputSourceTexture(null);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      ground.geometry.dispose();
      if (Array.isArray(ground.material)) {
        for (const material of ground.material) material.dispose();
      } else {
        ground.material.dispose();
      }
      postQuad.geometry.dispose();
      postMaterial.dispose();
      idTarget.dispose();
      edgeTarget.dispose();
      view.dispose();
    };
  }
};

export default experiment;
