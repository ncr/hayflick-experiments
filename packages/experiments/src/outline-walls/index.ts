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
uniform vec3 uOutlineColor;
uniform float uOutlineMix;
uniform int uDebugMode; // 0=final, 1=color, 2=depth, 3=normal, 4=id, 5=edgeOnly, 6=depthEdge, 7=normalEdge

varying vec2 vUv;

float linearizeDepth(float raw) {
  float z = raw * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
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
  float depthFrontL = step(dC, dL);
  float depthFrontR = step(dC, dR);
  float depthFrontU = step(dC, dU);
  float depthFrontD = step(dC, dD);

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

  float nEdgeL = step(uNormalThreshold, 1.0 - dot(nC, nL)) * normalFrontL * keepL;
  float nEdgeR = step(uNormalThreshold, 1.0 - dot(nC, nR)) * normalFrontR * keepR;
  float nEdgeU = step(uNormalThreshold, 1.0 - dot(nC, nU)) * normalFrontU * keepU;
  float nEdgeD = step(uNormalThreshold, 1.0 - dot(nC, nD)) * normalFrontD * keepD;
  float normalEdge = max(max(nEdgeL, nEdgeR), max(nEdgeU, nEdgeD));

  float edge = max(depthEdge, normalEdge);

  vec3 outColor = mix(c, uOutlineColor, edge * uOutlineMix);

  if (uDebugMode == 1) outColor = c;
  else if (uDebugMode == 2) outColor = vec3(pow(1.0 - rawC, 32.0));
  else if (uDebugMode == 3) outColor = texture2D(uNormalTex, cUv).rgb;
  else if (uDebugMode == 4) outColor = texture2D(uIdTex, cUv).rgb;
  else if (uDebugMode == 5) outColor = vec3(edge);
  else if (uDebugMode == 6) outColor = vec3(depthEdge, 0.0, 0.0);
  else if (uDebugMode == 7) outColor = vec3(0.0, normalEdge, 0.0);

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

async function loadWallTemplate(): Promise<THREE.Group> {
  const url = "/api/assets/read?path=tilesets%2Fgreek_island_white%2Ftiles%2Fwall%2Fwall.glb";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load wall: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });
  return gltf.scene;
}

function setNearestFiltering(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial && m.map) {
        m.map.magFilter = THREE.NearestFilter;
        m.map.minFilter = THREE.NearestFilter;
        m.map.needsUpdate = true;
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

    // Lighting — simple key + ambient, shader is mostly about silhouettes.
    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfff6e0, 1.4);
    key.position.set(3, 6, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x98b0d6, 0.45);
    fill.position.set(-3, 4, -2);
    scene.add(fill);

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

    // Pixel-perfect iso-2:1 view.
    const view = new PixelPerfectView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: 240,
      baseOrthoHeight: 6.0,
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
    const colorTarget = new THREE.WebGLRenderTarget(initialLow.width, initialLow.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false
    });
    colorTarget.texture.generateMipmaps = false;
    colorTarget.depthTexture = new THREE.DepthTexture(
      initialLow.width,
      initialLow.height,
      THREE.UnsignedIntType
    );
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
    const postTarget = makeAuxTarget(colorTarget.width, colorTarget.height);

    const normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

    const postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorTex: { value: colorTarget.texture },
        uDepthTex: { value: colorTarget.depthTexture },
        uNormalTex: { value: normalTarget.texture },
        uIdTex: { value: idTarget.texture },
        uResolution: { value: new THREE.Vector2(colorTarget.width, colorTarget.height) },
        uNear: { value: view.camera.near },
        uFar: { value: view.camera.far },
        uDepthThreshold: { value: 0.05 },
        uNormalThreshold: { value: 0.3 },
        uIdSuppressNormalDot: { value: maskEnabled ? 0.5 : 2.0 },
        uOutlineColor: { value: new THREE.Color(0xff3355) },
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

    // Build outline groups. All 3 walls normally share one id so their internal
    // seams are suppressed (visually one continuous wall). With
    // ?outlineGroups=split we give each wall a distinct id to see the seams
    // reappear — confirms the mask is actually working.
    const splitGroups = params.get("outlineGroups") === "split";
    const wallGroups = splitGroups
      ? [createOutlineGroup(1), createOutlineGroup(2), createOutlineGroup(3)]
      : [createOutlineGroup(1), createOutlineGroup(1), createOutlineGroup(1)];

    // Load and place 3 wall segments.
    const wallEntries: WallMeshEntry[] = [];
    const wallsGroup = new THREE.Group();

    // Bright standard material so the outline is visible against the backdrop.
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8d8bd,
      roughness: 0.85,
      metalness: 0.0
    });

    try {
      const template = await loadWallTemplate();
      setNearestFiltering(template);
      // Replace materials with the bright standard; the GLB's own materials
      // are stored in userData for optional re-enable later.
      template.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.material = wallMaterial;
        }
      });

      // Wall's native size (from manifest) is 128 units long. Scale to match
      // roughly "one tile" (1.28 world units) wide like the level editor does.
      const WORLD_UNIT = 1.28;
      const SCALE = WORLD_UNIT / 128;
      const SEGMENT_WORLD_LEN = WORLD_UNIT; // 128 * SCALE

      for (let i = 0; i < 3; i++) {
        const instance = template.clone(true);
        instance.scale.setScalar(SCALE);
        // Lay them out along +X, centred as a group. Optionally push the
        // middle wall forward by 8 cm to create a visible depth discontinuity
        // at both seams — used to demonstrate the id mask's effect.
        const z = staggerMiddle && i === 1 ? 0.08 : 0;
        instance.position.set((i - 1) * SEGMENT_WORLD_LEN, 0, z);
        wallsGroup.add(instance);

        const group = wallGroups[i] ?? wallGroups[0];
        instance.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          wallEntries.push({
            mesh: obj,
            originalMaterial: obj.material,
            idMaterial: group.idMaterial
          });
        });
      }

    } catch (err) {
      console.error("[outline-walls] wall load failed:", err);
    }

    // Centre the trio on the view target. PixelPerfectView locks its camera
    // target at Y=0 for non-side modes, so translate the walls down by half
    // their height instead.
    wallsGroup.position.set(0, -1.4, 0);
    scene.add(wallsGroup);

    // Resize: keep the three aux targets in lockstep with colorTarget.
    const syncAuxTargets = () => {
      const { width: w, height: h } = colorTarget;
      if (normalTarget.width !== w || normalTarget.height !== h) normalTarget.setSize(w, h);
      if (idTarget.width !== w || idTarget.height !== h) idTarget.setSize(w, h);
      if (postTarget.width !== w || postTarget.height !== h) postTarget.setSize(w, h);
      (postMaterial.uniforms.uResolution.value as THREE.Vector2).set(w, h);
      postMaterial.uniforms.uNear.value = view.camera.near;
      postMaterial.uniforms.uFar.value = view.camera.far;
      // The DepthTexture is sized by setSize on colorTarget above; no extra
      // handling needed.
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

      // Pass 2: normals.
      scene.overrideMaterial = normalMaterial;
      renderer.setRenderTarget(normalTarget);
      renderer.clear();
      renderer.render(scene, view.camera);
      scene.overrideMaterial = null;

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
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;
      view.frame(now, dt);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unbindInput();
      window.removeEventListener("keydown", onKey);
      hud.remove();
      view.afterSceneRender = null;
      view.setOutputSourceTexture(null);
      normalTarget.dispose();
      idTarget.dispose();
      postTarget.dispose();
      normalMaterial.dispose();
      postMaterial.dispose();
      postQuad.geometry.dispose();
      postScene.remove(postQuad);
      for (const g of wallGroups) g.idMaterial.dispose();
      scene.remove(wallsGroup);
      view.dispose();
    };
  }
};

export default experiment;
