import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PixelPerfectView } from "@common/render";
import { bindPixelPerfectViewInput } from "@common/input";
import type { ExperimentModule } from "../runtime/types";

/* ------------------------------------------------------------------ */
/* Edge-detect postprocess shader                                      */
/* ------------------------------------------------------------------ */

const POST_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Depth + normal edge detection, one-sided (outline sits on the near side),
// with a group-id mask: when a pixel and its neighbour share the same outline
// group AND have effectively identical normals, we suppress the edge between
// them so coplanar seams across adjacent meshes vanish. Corner-style edges
// within the group (top face vs front face) differ in normal, so they survive.
const POST_FS = /* glsl */ `
precision highp float;

uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform sampler2D uNormalTex;
uniform sampler2D uIdTex;

uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uIdSuppressNormalDot;
uniform float uOutlineBrightness;
uniform float uOutlineMix;
uniform int uDebugMode; // 0=final, 1=color, 2=depth, 3=normal, 4=id, 5=edgeOnly, 6=depthEdge, 7=normalEdge

varying vec2 vUv;

// Depth is stored as linear view-z in [0, 1] via our custom depth shader,
// so linearizeDepth is just a remap to world units. No RGBA unpacking needed.
float linearizeDepth(float raw) {
  return raw * (uFar - uNear) + uNear;
}

vec2 clampUv(vec2 uv, vec2 texel) {
  return clamp(uv, texel * 0.5, vec2(1.0) - texel * 0.5);
}

void main() {
  vec2 texel = 1.0 / uResolution;
  vec2 cUv = vUv;
  vec2 lUv = clampUv(cUv + vec2(-texel.x, 0.0), texel);
  vec2 rUv = clampUv(cUv + vec2( texel.x, 0.0), texel);
  vec2 uUvc = clampUv(cUv + vec2(0.0, -texel.y), texel);
  vec2 dUv = clampUv(cUv + vec2(0.0,  texel.y), texel);

  vec3 c = texture2D(uColorTex, cUv).rgb;

  float rawC = texture2D(uDepthTex, cUv).r;
  float rawL = texture2D(uDepthTex, lUv).r;
  float rawR = texture2D(uDepthTex, rUv).r;
  float rawU = texture2D(uDepthTex, uUvc).r;
  float rawD = texture2D(uDepthTex, dUv).r;

  float dC = linearizeDepth(rawC);
  float dL = linearizeDepth(rawL);
  float dR = linearizeDepth(rawR);
  float dU = linearizeDepth(rawU);
  float dD = linearizeDepth(rawD);

  vec3 nC = normalize(texture2D(uNormalTex, cUv).rgb * 2.0 - 1.0);
  vec3 nL = normalize(texture2D(uNormalTex, lUv).rgb * 2.0 - 1.0);
  vec3 nR = normalize(texture2D(uNormalTex, rUv).rgb * 2.0 - 1.0);
  vec3 nU = normalize(texture2D(uNormalTex, uUvc).rgb * 2.0 - 1.0);
  vec3 nD = normalize(texture2D(uNormalTex, dUv).rgb * 2.0 - 1.0);

  vec3 idC = texture2D(uIdTex, cUv).rgb;
  vec3 idL = texture2D(uIdTex, lUv).rgb;
  vec3 idR = texture2D(uIdTex, rUv).rgb;
  vec3 idU = texture2D(uIdTex, uUvc).rgb;
  vec3 idD = texture2D(uIdTex, dUv).rgb;

  // One-sided front test for DEPTH edges: center "wins" only if its depth is
  // smaller than or equal to the neighbour's. This concentrates the silhouette
  // outline onto the nearer surface, giving a 1-pixel-wide edge.
  // Same L/U-vs-R/D tie-break asymmetry as normalFront so when the two rules
  // get mixed by depthGate, the resulting 1-px thickness is preserved.
  //   L/U: fire when dC <= dN (tie goes to C)
  //   R/D: fire only when dC < dN strictly (tie goes to N)
  float depthFrontL = step(dC, dL);
  float depthFrontR = step(dC + 1e-4, dR);
  float depthFrontU = step(dC, dU);
  float depthFrontD = step(dC + 1e-4, dD);

  // Normal edges: center "wins" the boundary when its face is more
  // camera-facing than the neighbour's. View-space normal.z (from
  // MeshNormalMaterial) is exactly that — higher = more perpendicular to
  // view. When the two faces are equally camera-facing (e.g. a front/side
  // wall corner at the 45° iso yaw), fall back to an asymmetric L/U bias so
  // the edge still appears and always on the same side.
  //   L/U: fire when nC.z >= nN.z (tie goes to C)
  //   R/D: fire only when nC.z > nN.z strictly (tie goes to N)
  // This is rotation-invariant and keeps the outline 1-pixel thick.
  float normalFrontL = step(nL.z - 1e-4, nC.z);
  float normalFrontR = step(nR.z + 1e-4, nC.z);
  float normalFrontU = step(nU.z - 1e-4, nC.z);
  float normalFrontD = step(nD.z + 1e-4, nC.z);

  // When a depth discontinuity exists across the boundary, the transition
  // is not an in-mesh crease — it's a silhouette where one surface occludes
  // another. The nz-based "more camera-facing wins" rule can place the
  // edge on the far surface's pixel (e.g. a back mesh's front face visible
  // just above a front mesh's top face), which makes the front mesh look
  // 1 iso-row thinner than the same mesh when it has plain background
  // above. The depth buffer answers the "which side is the silhouette on?"
  // question unambiguously: the NEARER side owns the edge.
  float depthDiffL = abs(dC - dL);
  float depthDiffR = abs(dC - dR);
  float depthDiffU = abs(dC - dU);
  float depthDiffD = abs(dC - dD);
  float depthGateL = step(uDepthThreshold, depthDiffL);
  float depthGateR = step(uDepthThreshold, depthDiffR);
  float depthGateU = step(uDepthThreshold, depthDiffU);
  float depthGateD = step(uDepthThreshold, depthDiffD);
  float edgeSideL = mix(normalFrontL, depthFrontL, depthGateL);
  float edgeSideR = mix(normalFrontR, depthFrontR, depthGateR);
  float edgeSideU = mix(normalFrontU, depthFrontU, depthGateU);
  float edgeSideD = mix(normalFrontD, depthFrontD, depthGateD);

  // ID suppression: if both sides belong to the same outline group AND their
  // normals agree, treat the boundary as a virtual seam and skip the edge.
  float ID_EPS = 0.05;
  float sameIdL = step(length(idC - idL), ID_EPS);
  float sameIdR = step(length(idC - idR), ID_EPS);
  float sameIdU = step(length(idC - idU), ID_EPS);
  float sameIdD = step(length(idC - idD), ID_EPS);

  float sameNormalL = step(uIdSuppressNormalDot, dot(nC, nL));
  float sameNormalR = step(uIdSuppressNormalDot, dot(nC, nR));
  float sameNormalU = step(uIdSuppressNormalDot, dot(nC, nU));
  float sameNormalD = step(uIdSuppressNormalDot, dot(nC, nD));

  float keepL = 1.0 - (sameIdL * sameNormalL);
  float keepR = 1.0 - (sameIdR * sameNormalR);
  float keepU = 1.0 - (sameIdU * sameNormalU);
  float keepD = 1.0 - (sameIdD * sameNormalD);

  float dEdgeL = step(uDepthThreshold, abs(dC - dL)) * depthFrontL * keepL;
  float dEdgeR = step(uDepthThreshold, abs(dC - dR)) * depthFrontR * keepR;
  float dEdgeU = step(uDepthThreshold, abs(dC - dU)) * depthFrontU * keepU;
  float dEdgeD = step(uDepthThreshold, abs(dC - dD)) * depthFrontD * keepD;
  float depthEdge = max(max(dEdgeL, dEdgeR), max(dEdgeU, dEdgeD));

  float nEdgeL = step(uNormalThreshold, 1.0 - dot(nC, nL)) * edgeSideL * keepL;
  float nEdgeR = step(uNormalThreshold, 1.0 - dot(nC, nR)) * edgeSideR * keepR;
  float nEdgeU = step(uNormalThreshold, 1.0 - dot(nC, nU)) * edgeSideU * keepU;
  float nEdgeD = step(uNormalThreshold, 1.0 - dot(nC, nD)) * edgeSideD * keepD;
  float normalEdge = max(max(nEdgeL, nEdgeR), max(nEdgeU, nEdgeD));

  // Id-boundary edge: catches coplanar, same-normal seams between different
  // outline groups (e.g., a corner column meeting a window tile whose outer
  // face is flush with the corner's — same +X normal, different piece).
  // Neither depth nor normal tests fire for these, so without this pass the
  // piece boundary is invisible even though the user expects a crease.
  // Use edgeSide (depth-gated) rather than raw normalFront so that when a
  // boundary has BOTH a depth discontinuity AND an id transition (e.g. wall
  // meeting door trim at a recessed door), the id-edge and depth-edge fire
  // on the same iso-col instead of adjacent ones — otherwise the combined
  // edge becomes 2 iso-px wide.
  float iEdgeL = (1.0 - sameIdL) * sameNormalL * edgeSideL;
  float iEdgeR = (1.0 - sameIdR) * sameNormalR * edgeSideR;
  float iEdgeU = (1.0 - sameIdU) * sameNormalU * edgeSideU;
  float iEdgeD = (1.0 - sameIdD) * sameNormalD * edgeSideD;
  float idEdge = max(max(iEdgeL, iEdgeR), max(iEdgeU, iEdgeD));

  float edge = max(max(depthEdge, normalEdge), idEdge);

  vec3 brighter = min(c * uOutlineBrightness, vec3(1.0));
  vec3 outColor = mix(c, brighter, edge * uOutlineMix);

  if (uDebugMode == 1) outColor = c;
  else if (uDebugMode == 2) outColor = vec3(pow(1.0 - rawC, 8.0));
  else if (uDebugMode == 3) outColor = texture2D(uNormalTex, cUv).rgb;
  else if (uDebugMode == 4) outColor = texture2D(uIdTex, cUv).rgb;
  else if (uDebugMode == 5) outColor = vec3(edge);
  else if (uDebugMode == 6) outColor = vec3(depthEdge, 0.0, 0.0);
  // "normalEdge" in the UI sense = every non-silhouette crease, which
  // includes id-boundary seams between coplanar same-normal pieces.
  else if (uDebugMode == 7) outColor = vec3(0.0, max(normalEdge, idEdge), 0.0);

  gl_FragColor = vec4(outColor, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* ID material — one per outline group                                  */
/* ------------------------------------------------------------------ */

const ID_VS = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ID_FS = /* glsl */ `
precision highp float;
uniform vec3 uIdColor;
void main() {
  gl_FragColor = vec4(uIdColor, 1.0);
}
`;

type OutlineGroup = {
  id: number;
  color: THREE.Color;
  idMaterial: THREE.ShaderMaterial;
};

const ID_EPS = 1 / 255;

function encodeGroupIdToColor(groupId: number): THREE.Color {
  // Pack a small integer into a high-contrast RGB so neighbouring pixels with
  // different group ids are separable after sub-1/255 rounding.
  const r = ((groupId * 53 + 37) & 0xff) / 255;
  const g = ((groupId * 131 + 71) & 0xff) / 255;
  const b = ((groupId * 197 + 113) & 0xff) / 255;
  return new THREE.Color(Math.max(ID_EPS, r), Math.max(ID_EPS, g), Math.max(ID_EPS, b));
}

function createOutlineGroup(id: number): OutlineGroup {
  const color = encodeGroupIdToColor(id);
  const idMaterial = new THREE.ShaderMaterial({
    uniforms: { uIdColor: { value: color.clone() } },
    vertexShader: ID_VS,
    fragmentShader: ID_FS,
    side: THREE.DoubleSide
  });
  return { id, color, idMaterial };
}

/* ------------------------------------------------------------------ */
/* Wall loading                                                        */
/* ------------------------------------------------------------------ */

type WallMeshEntry = {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  idMaterial: THREE.ShaderMaterial;
};

const KNOWN_TILESETS = new Set(["greek_island_white", "desert_sandstone"]);
const ROOM_TILE_NAMES = [
  "wall",
  "corner",
  "door",
  "floor_tile",
  "window_left",
  "window_middle"
] as const;
type RoomTileName = (typeof ROOM_TILE_NAMES)[number];

async function loadTileTemplate(tileset: string, tileName: string): Promise<THREE.Group> {
  const id = KNOWN_TILESETS.has(tileset) ? tileset : "greek_island_white";
  const path = `tilesets/${id}/artifacts/tiles/${tileName}/${tileName}.glb`;
  const url = `/api/assets/read?path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${tileName}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });
  return gltf.scene;
}

async function loadRoomTemplates(
  tileset: string
): Promise<Partial<Record<RoomTileName, THREE.Group>>> {
  const entries = await Promise.all(
    ROOM_TILE_NAMES.map(async (name): Promise<[RoomTileName, THREE.Group | null]> => {
      try {
        return [name, await loadTileTemplate(tileset, name)];
      } catch (err) {
        console.warn(`[outline-walls] ${tileset}/${name} failed:`, err);
        return [name, null];
      }
    })
  );
  const out: Partial<Record<RoomTileName, THREE.Group>> = {};
  for (const [name, group] of entries) {
    if (group) out[name] = group;
  }
  return out;
}

function setNearestFiltering(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      const maps: (THREE.Texture | null | undefined)[] = [
        m.map,
        m.normalMap,
        m.roughnessMap,
        m.metalnessMap,
        m.aoMap
      ];
      for (const t of maps) {
        if (!t) continue;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.needsUpdate = true;
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Experiment                                                          */
/* ------------------------------------------------------------------ */

const experiment: ExperimentModule = {
  id: "outline-walls",
  title: "Outline Walls",
  tags: ["threejs", "pixel-perfect", "outline", "postprocess", "walls"],
  init: async ({ mount, width, height }) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d2029);

    // Lighting — moderate ambient + key/fill so the plaster texture is
    // readable everywhere, plus an orbiting point light that drives the
    // visible normal-map relief and roughness highlight.
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfff6e0, 1.1);
    key.position.set(2, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x98b0d6, 0.35);
    fill.position.set(-3, 4, -2);
    scene.add(fill);

    // Orbiting point light — big radius so it washes across the wall face,
    // rather than a tight hotspot. The traveling highlight is the visual
    // confirmation that PBR + normal mapping is active.
    const orbitLight = new THREE.PointLight(0xffe7c4, 4.0, 12.0, 1.2);
    const orbitPivot = new THREE.Object3D();
    orbitPivot.position.set(0, 0.2, 0);
    orbitPivot.add(orbitLight);
    orbitLight.position.set(2.2, 0.4, 0.0);
    scene.add(orbitPivot);

    const DEBUG_LABELS = [
      "final",
      "color",
      "depth",
      "normal",
      "id",
      "edgeOnly",
      "depthEdgeOnly",
      "normalEdgeOnly"
    ];
    const params = new URLSearchParams(window.location.search);
    let debugMode = Math.max(
      0,
      Math.min(DEBUG_LABELS.length - 1, Number(params.get("outlineDebug") ?? "0") | 0)
    );
    const initialZoom = Math.max(
      1,
      Math.min(8, Number(params.get("outlineZoom") ?? "1") | 0)
    );
    // Force the id mask off via ?outlineMask=0 to see the un-suppressed seams.
    const maskEnabled = (params.get("outlineMask") ?? "1") !== "0";
    // Stagger the middle wall's Z by a few cm via ?outlineStagger=1 to force
    // a depth discontinuity at the wall interface — exercises the id mask.
    const staggerMiddle = params.get("outlineStagger") === "1";
    // Enable GPU read-back of the post-processed low-res texture into
    // window.__outlineLow__ for pixel-perfect test inspection. Off by default
    // because readRenderTargetPixels forces a GPU stall each frame.
    const lowPixelReadback = params.get("outlineReadback") === "1";
    // Pick a wall kit. `greek_island_white` (default) is plaster; `desert_sandstone`
    // is a sandstone variant. Both ship through the same blockstudio PBR pipeline.
    const tilesetId = params.get("outlineTileset") ?? "greek_island_white";
    // Scene layout: `strip` (default) = 3 adjacent wall segments for the outline
    // suppression test; `room` = full mockup using every kit piece (floor, walls,
    // door, windows, corners) to showcase PBR + outline on a complete structure;
    // `grid` = isolated debug scene that places N×N window_middle tiles in a
    // plain grid with no rotation so we can compare the rasterisation of
    // geometrically-identical tiles at different world positions.
    const rawSceneKind = params.get("outlineScene");
    const sceneKind: "strip" | "room" | "grid" =
      rawSceneKind === "room" ? "room" : rawSceneKind === "grid" ? "grid" : "strip";
    // `outlineGridSize=N` controls the grid resolution (default 3 → 3×3 tiles).
    const gridSize = Math.max(1, Math.min(7, Number(params.get("outlineGridSize") ?? "3") | 0));
    // `outlineGridAxis=x|z|diag` — along which world axis to lay out the grid.
    const gridAxis = (params.get("outlineGridAxis") ?? "diag") as "x" | "z" | "diag";

    // Pixel-perfect iso-2:1 view.
    const view = new PixelPerfectView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: 240,
      // 4.8 * √2 makes scale = 240 / (4.8·√2) = 25·√2. With yaw=π/4 and
      // pitch=30°, this gives per-world-unit screen_x = 25 and per-world-unit
      // screen_y from (x+z) = 12.5 iso-pixels. Tile centres (multiples of
      // 1.28 m) then land on integer iso rows/cols, and any mesh dimension
      // that's a multiple of 8 cm also lands on integers — eliminating the
      // sub-pixel flip between the two window walls that `yaw·cos=√2/2` would
      // otherwise introduce. (Default 6.0 leaves 40/(iso projection) = 10·√2
      // per unit on the vertical axis, which is irrational and causes the
      // two glass slabs to rasterise 1 row apart from each other.)
      baseOrthoHeight: 4.8 * Math.SQRT2,
      cameraDistance: 40,
      cameraPitch: "iso-2to1",
      cameraYaw: Math.PI / 4,
      basePixelZoom: initialZoom,
      zoomMin: 1,
      zoomMax: 8,
      zoomStep: 1,
      zoomAnimationRate: 12,
      zoomAnimationBurstRate: 24,
      zoomAnimationEpsilon: 0.01,
      // Rotation: moderate ease rate, but hand off to the final snap phase
      // early (larger epsilon) so we don't spend a few hundred ms easing
      // sub-pixel at the tail — that was causing visible shimmer on
      // non-quarter-turn yaws.
      rotationAnimationRate: 20,
      rotationAnimationEpsilon: 0.08,
      zoomBurstIdleMs: 300,
      outputOverscanLowPixels: 2,
      clearColor: 0x1d2029
    });

    const unbindInput = bindPixelPerfectViewInput({ view });

    // Replace lowTarget with one that carries a DepthTexture, no MSAA
    // (multisampled depth is awkward to read). This becomes our color+depth
    // pass target.
    const initialLow = view.getLowTarget();
    const depthTexture = new THREE.DepthTexture(
      initialLow.width,
      initialLow.height,
      THREE.UnsignedIntType
    );
    const colorTarget = new THREE.WebGLRenderTarget(initialLow.width, initialLow.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false,
      depthBuffer: true,
      depthTexture
    });
    colorTarget.texture.generateMipmaps = false;
    view.setLowTarget(colorTarget);

    // Auxiliary targets — normals, ids, and the final post-processed image.
    const makeAuxTarget = (w: number, h: number): THREE.WebGLRenderTarget => {
      const t = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        stencilBuffer: false
      });
      t.texture.generateMipmaps = false;
      return t;
    };
    const normalTarget = makeAuxTarget(colorTarget.width, colorTarget.height);
    const idTarget = makeAuxTarget(colorTarget.width, colorTarget.height);
    // Depth target uses HalfFloatType (16-bit) — plain RGBA8 quantises the
    // [0, 1] depth range into 256 buckets, and with near=0.1 far=200 that's
    // ~0.78 world units per bucket, well above our 0.05 uDepthThreshold.
    // The threshold is then effectively ignored and adjacent pixels that
    // happen to fall on different buckets generate orphan depth-edge pixels
    // scattered across flat surfaces.
    const depthPackedTarget = new THREE.WebGLRenderTarget(colorTarget.width, colorTarget.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      stencilBuffer: false
    });
    depthPackedTarget.texture.generateMipmaps = false;
    const postTarget = makeAuxTarget(colorTarget.width, colorTarget.height);

    const normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

    // Custom depth material: writes linear view-z (camera-space distance,
    // clamped to [0, 1] via near/far) into the R channel. We do NOT use
    // three.js MeshDepthMaterial/DepthTexture here because both silently
    // return unusable depth on several WebGL2 + ortho camera configs
    // (DepthTexture returns 1.0, MeshDepthMaterial packs gl_FragCoord.z
    // which is non-linear and interacts badly with ortho on some GPUs).
    // Writing linear view-z via a custom shader is bedrock-reliable.
    const DEPTH_VS = /* glsl */ `
      varying float vViewZ;
      void main() {
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -viewPos.z; // positive = distance in front of camera
        gl_Position = projectionMatrix * viewPos;
      }
    `;
    const DEPTH_FS = /* glsl */ `
      precision highp float;
      uniform float uNear;
      uniform float uFar;
      varying float vViewZ;
      void main() {
        // Linear depth in [0, 1], clamped to [near, far] range.
        float d = clamp((vViewZ - uNear) / (uFar - uNear), 0.0, 1.0);
        gl_FragColor = vec4(d, d, d, 1.0);
      }
    `;
    const depthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uNear: { value: view.camera.near },
        uFar: { value: view.camera.far }
      },
      vertexShader: DEPTH_VS,
      fragmentShader: DEPTH_FS,
      side: THREE.DoubleSide
    });

    const postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorTex: { value: colorTarget.texture },
        uDepthTex: { value: depthPackedTarget.texture },
        uNormalTex: { value: normalTarget.texture },
        uIdTex: { value: idTarget.texture },
        uResolution: { value: new THREE.Vector2(colorTarget.width, colorTarget.height) },
        uNear: { value: view.camera.near },
        uFar: { value: view.camera.far },
        uDepthThreshold: { value: 0.05 },
        uNormalThreshold: { value: 0.3 },
        uIdSuppressNormalDot: { value: maskEnabled ? 0.5 : 2.0 },
        uOutlineBrightness: { value: 1.35 },
        uOutlineMix: { value: 1.0 },
        uDebugMode: { value: debugMode }
      },
      vertexShader: POST_VS,
      fragmentShader: POST_FS,
      depthTest: false
    });
    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
    postQuad.frustumCulled = false;
    postScene.add(postQuad);

    // Outline groups. In the 3-wall strip, ?outlineGroups=split assigns one id
    // per wall so the seams reappear; otherwise all walls share one id. The
    // room scene groups by *material*: everything using `blockstudio_wall`
    // (walls, corners, door frame, window-left wall) shares one id so their
    // seams vanish; glass (`blockstudio_accent`) gets its own id so the
    // wall↔glass boundary draws; door leaf (`blockstudio_trim`) gets a third
    // id so the door boundary draws. This is what the user asked for — no
    // extra seams between wall pieces, but glass is clearly outlined.
    const splitGroups = params.get("outlineGroups") === "split";
    const stripWallGroups =
      sceneKind === "strip" && splitGroups
        ? [createOutlineGroup(1), createOutlineGroup(2), createOutlineGroup(3)]
        : [createOutlineGroup(1), createOutlineGroup(1), createOutlineGroup(1)];
    const wallGroup = stripWallGroups[0];
    const glassGroup = createOutlineGroup(20);
    const trimGroup = createOutlineGroup(21);
    const allGroupsToDispose: OutlineGroup[] = [
      ...stripWallGroups,
      glassGroup,
      trimGroup
    ];

    const wallEntries: WallMeshEntry[] = [];
    const wallsGroup = new THREE.Group();

    // GLB already carries a 1/128 parent-node scale so the authoring-space
    // mesh (128 units long) renders at 1 unit wide. Scale each instance by
    // WORLD_UNIT to match the map editor's one-tile sizing.
    const WORLD_UNIT = 1.28;

    // Pick an outline group id for a mesh based on its material name.
    // `blockstudio_accent` → glass, `blockstudio_trim` → door leaf, anything
    // else (including `blockstudio_wall`) → the shared wall id.
    const idMaterialForMesh = (
      mesh: THREE.Mesh,
      fallback: THREE.ShaderMaterial
    ): THREE.ShaderMaterial => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const name = m?.name ?? "";
        if (name === "blockstudio_accent") return glassGroup.idMaterial;
        if (name === "blockstudio_trim") return trimGroup.idMaterial;
      }
      return fallback;
    };

    const registerInstance = (instance: THREE.Object3D, idMaterial: THREE.ShaderMaterial) => {
      instance.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        wallEntries.push({
          mesh: obj,
          originalMaterial: obj.material,
          idMaterial: idMaterialForMesh(obj, idMaterial)
        });
      });
    };

    // The glass slab is authored 4cm thick. In iso-2:1 that maps to sub-pixel
    // vertical separation between the silhouette (bg→top-face) and the
    // top-face→front-face crease. Rounding renders the two as the same pixel
    // row on some orientations and separate rows on others, so the appearance
    // flips across camera yaws. Scaling the top-face span to ≥ 2 iso rows
    // forces a consistent 1-pixel black row between the two edges.
    const GLASS_THICKNESS_SCALE = 4.0;
    const thickenGlass = (root: THREE.Object3D) => {
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        const isGlass = mats.some((m) => (m?.name ?? "") === "blockstudio_accent");
        if (!isGlass) return;
        obj.geometry.computeBoundingBox();
        const bb = obj.geometry.boundingBox;
        if (!bb) return;
        const sx = bb.max.x - bb.min.x;
        const sy = bb.max.y - bb.min.y;
        const sz = bb.max.z - bb.min.z;
        if (sx <= sy && sx <= sz) obj.scale.x = GLASS_THICKNESS_SCALE;
        else if (sy <= sz) obj.scale.y = GLASS_THICKNESS_SCALE;
        else obj.scale.z = GLASS_THICKNESS_SCALE;
      });
    };

    try {
      if (sceneKind === "strip") {
        const template = await loadTileTemplate(tilesetId, "wall");
        setNearestFiltering(template);
        for (let i = 0; i < 3; i++) {
          const instance = template.clone(true);
          instance.scale.setScalar(WORLD_UNIT);
          // Lay them out along +X, centred as a group. Optionally push the
          // middle wall forward by 8 cm to create a visible depth discontinuity
          // at both seams — used to demonstrate the id mask's effect.
          const z = staggerMiddle && i === 1 ? 0.08 : 0;
          instance.position.set((i - 1) * WORLD_UNIT, 0, z);
          wallsGroup.add(instance);
          registerInstance(instance, (stripWallGroups[i] ?? stripWallGroups[0]).idMaterial);
        }
      } else if (sceneKind === "room") {
        const templates = await loadRoomTemplates(tilesetId);
        for (const t of Object.values(templates)) {
          if (t) setNearestFiltering(t);
        }
        const place = (
          name: RoomTileName,
          cellX: number,
          cellZ: number,
          yaw = 0
        ) => {
          const tmpl = templates[name];
          if (!tmpl) return;
          const instance = tmpl.clone(true);
          instance.scale.setScalar(WORLD_UNIT);
          instance.position.set(cellX * WORLD_UNIT, 0, cellZ * WORLD_UNIT);
          instance.rotation.y = yaw;
          thickenGlass(instance);
          wallsGroup.add(instance);
          registerInstance(instance, wallGroup.idMaterial);
        };

        // 3x3 cell room. Cell indices (i,j) in [-1,0,1]; perimeter vertex
        // indices in [-1.5, 1.5]. The corner piece occupies one full tile's
        // footprint (its L-arms extend 1 tile in each adjacent direction),
        // so the outermost wall slots on each side are *replaced* by the
        // corner — the middle slot holds the plain wall / door / window.
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            place("floor_tile", i, j);
          }
        }
        // Back (Z = -1.5), middle slot.
        place("wall", 0, -1.5);
        // Front (Z = +1.5), door in the middle.
        place("door", 0, 1.5);
        // Left and right walls both use window_middle (plain glass) for
        // matching geometry — window_left carries an extra wall-frame mesh
        // which, rotated onto the left wall, would show a different outline
        // pattern than window_middle on the right.
        place("window_middle", -1.5, 0, Math.PI / 2);
        place("window_middle", 1.5, 0, Math.PI / 2);
        // Four outer corners — rotations derived from the corner mesh's
        // default arms (+X and -Z) so the L wraps correctly at each vertex:
        //   NW (-1.5,-1.5) wants arms (+X,+Z): 3π/2
        //   NE (+1.5,-1.5) wants arms (-X,+Z): π
        //   SE (+1.5,+1.5) wants arms (-X,-Z): π/2
        //   SW (-1.5,+1.5) wants arms (+X,-Z): 0
        place("corner", -1.5, -1.5, (3 * Math.PI) / 2);
        place("corner", 1.5, -1.5, Math.PI);
        place("corner", 1.5, 1.5, Math.PI / 2);
        place("corner", -1.5, 1.5, 0);
      } else if (sceneKind === "grid") {
        // Isolation scene: place identical rotated window_middle tiles at
        // the *same* cell coordinates the room scene uses (±1.5, 0), so we
        // reproduce the actual failure case — two tiles at opposite X, all
        // other variables held fixed. `outlineGridAxis` overrides the axis:
        //   x    → tiles along X (default; matches ±X walls)
        //   z    → tiles along Z
        //   diag → tiles on the diag (x+z constant sub-pixel offset)
        // `outlineGridSize` scales the number of tiles (default 3 → at -1.5,
        //  0, +1.5 along the chosen axis).
        const template = await loadTileTemplate(tilesetId, "window_middle");
        setNearestFiltering(template);
        const offsets: number[] = [];
        if (gridSize === 2) {
          // Match the room scene's window positions exactly: ±1.5 tiles apart.
          offsets.push(-1.5, 1.5);
        } else {
          // 1 tile apart by default. `outlineGridStride=N` overrides (default 1).
          const stride = Math.max(1, Number(params.get("outlineGridStride") ?? "1") | 0);
          const half = (gridSize - 1) / 2;
          for (let i = 0; i < gridSize; i++) offsets.push((i - half) * stride);
        }
        for (const off of offsets) {
          const cellX = gridAxis === "z" ? 0 : off;
          const cellZ = gridAxis === "x" ? 0 : gridAxis === "z" ? off : off;
          const instance = template.clone(true);
          instance.scale.setScalar(WORLD_UNIT);
          instance.position.set(cellX * WORLD_UNIT, 0, cellZ * WORLD_UNIT);
          instance.rotation.y = Math.PI / 2;
          thickenGlass(instance);
          wallsGroup.add(instance);
          registerInstance(instance, wallGroup.idMaterial);
        }
      }
    } catch (err) {
      console.error("[outline-walls] scene load failed:", err);
    }

    // Centre the scene vertically on the view target. PixelPerfectView locks
    // its camera target at Y=0 for non-side modes, so translate downward by
    // roughly half the wall height.
    wallsGroup.position.set(0, -1.4, 0);
    scene.add(wallsGroup);

    // Resize: keep the aux targets in lockstep with colorTarget.
    const syncAuxTargets = () => {
      const { width: w, height: h } = colorTarget;
      if (normalTarget.width !== w || normalTarget.height !== h) normalTarget.setSize(w, h);
      if (idTarget.width !== w || idTarget.height !== h) idTarget.setSize(w, h);
      if (depthPackedTarget.width !== w || depthPackedTarget.height !== h) depthPackedTarget.setSize(w, h);
      if (postTarget.width !== w || postTarget.height !== h) postTarget.setSize(w, h);
      (postMaterial.uniforms.uResolution.value as THREE.Vector2).set(w, h);
      postMaterial.uniforms.uNear.value = view.camera.near;
      postMaterial.uniforms.uFar.value = view.camera.far;
      // The DepthTexture is sized by setSize on colorTarget above; no extra
      // handling needed.
    };

    // Tone mapping: apply ACES to the PBR color pass so lit walls look right.
    // Must be disabled around the normal/id passes (which write raw geometric
    // data that mustn't be compressed) and around the post composite (the
    // outline shader brightens pixels — tone mapping would clamp the output).
    view.beforeSceneRender = (renderer) => {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
    };

    let lowPixelBuf: Uint8Array | null = null;
    view.afterSceneRender = (renderer, lowTarget) => {
      // Aux targets must match the (possibly resized) lowTarget.
      if (
        normalTarget.width !== lowTarget.width ||
        normalTarget.height !== lowTarget.height
      ) {
        syncAuxTargets();
      }

      renderer.toneMapping = THREE.NoToneMapping;

      // Pass 2: normals.
      scene.overrideMaterial = normalMaterial;
      renderer.setRenderTarget(normalTarget);
      renderer.clear();
      renderer.render(scene, view.camera);
      scene.overrideMaterial = null;

      // Pass 2b: linear view-z depth into R channel. We null out
      // scene.background for this pass — otherwise three.js draws the scene
      // background colour into the depth target (converted from sRGB to
      // linear, so around 0.01) instead of leaving it at our clear colour
      // of 1.0 (= far plane). A non-1.0 "background depth" makes every
      // depth-edge fire in the wrong direction.
      const savedBackground = scene.background;
      scene.background = null;
      scene.overrideMaterial = depthMaterial;
      renderer.setRenderTarget(depthPackedTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(scene, view.camera);
      scene.overrideMaterial = null;
      scene.background = savedBackground;
      renderer.setClearColor(0x1d2029, 1);

      // Pass 3: ids. Walk the wall meshes, swap to the id material, render,
      // restore.
      for (const entry of wallEntries) entry.mesh.material = entry.idMaterial;
      renderer.setRenderTarget(idTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, view.camera);
      for (const entry of wallEntries) entry.mesh.material = entry.originalMaterial;
      renderer.setClearColor(0x1d2029, 1);

      // Pass 4: edge-detect composite.
      renderer.setRenderTarget(postTarget);
      renderer.clear();
      renderer.render(postScene, postCamera);

      view.setOutputSourceTexture(postTarget.texture);

      if (lowPixelReadback) {
        const w = postTarget.width;
        const h = postTarget.height;
        if (!lowPixelBuf || lowPixelBuf.length !== w * h * 4) {
          lowPixelBuf = new Uint8Array(w * h * 4);
        }
        renderer.readRenderTargetPixels(postTarget, 0, 0, w, h, lowPixelBuf);
        (window as unknown as { __outlineLow__?: unknown }).__outlineLow__ = {
          width: w,
          height: h,
          pixels: Array.from(lowPixelBuf)
        };
      }
    };

    // Viewport resize: observe the mount, forward to view.resize.
    const observer = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width > 0 && e.contentRect.height > 0) {
          view.resize(e.contentRect.width, e.contentRect.height);
        }
      }
    });
    observer.observe(mount);

    // HUD (small label, purely informational).
    const hud = document.createElement("div");
    hud.style.cssText =
      "position:absolute;top:8px;left:8px;padding:4px 8px;background:rgba(0,0,0,0.55);" +
      "color:#eee;font:11px/1.3 monospace;border-radius:3px;pointer-events:none;z-index:10;";
    hud.textContent = `outline-walls — [D] debug: ${DEBUG_LABELS[debugMode]} — pan: MMB, Q/E rotate, wheel zoom`;
    mount.style.position = "relative";
    mount.appendChild(hud);

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyD" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        debugMode = (debugMode + 1) % DEBUG_LABELS.length;
        postMaterial.uniforms.uDebugMode.value = debugMode;
        hud.textContent = `outline-walls — [D] debug: ${DEBUG_LABELS[debugMode]} — pan: MMB, Q/E rotate, wheel zoom`;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);

    let raf = 0;
    let prev = performance.now();
    const ORBIT_PERIOD_S = 6.0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;
      // Orbit on the world XZ plane around wallsGroup origin. Keeps the
      // point light circling in front of / behind the wall strip so the
      // highlight travels across the normal-mapped surface.
      const t = (now / 1000) * ((Math.PI * 2) / ORBIT_PERIOD_S);
      orbitPivot.rotation.y = t;
      view.frame(now, dt);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unbindInput();
      window.removeEventListener("keydown", onKey);
      hud.remove();
      view.beforeSceneRender = null;
      view.afterSceneRender = null;
      view.setOutputSourceTexture(null);
      normalTarget.dispose();
      idTarget.dispose();
      depthPackedTarget.dispose();
      postTarget.dispose();
      depthMaterial.dispose();
      normalMaterial.dispose();
      postMaterial.dispose();
      postQuad.geometry.dispose();
      postScene.remove(postQuad);
      for (const g of allGroupsToDispose) g.idMaterial.dispose();
      scene.remove(wallsGroup);
      scene.remove(orbitPivot);
      view.dispose();
    };
  }
};

export default experiment;
