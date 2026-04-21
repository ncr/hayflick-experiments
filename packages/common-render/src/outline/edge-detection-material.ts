import * as THREE from "three";

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

    // One-sided front test for DEPTH edges: L/U ≤ vs R/D < gives 1 iso-px
    // thickness regardless of direction. See README for why the asymmetry
    // matters when the depth-gate mixes with the normal rule.
    float depthFrontL = step(dC, dL);
    float depthFrontR = step(dC + 1e-4, dR);
    float depthFrontU = step(dC, dU);
    float depthFrontD = step(dC + 1e-4, dD);

    // Normal edges: center wins when more camera-facing (larger view-space nz).
    // Same L/U ≤ vs R/D < asymmetry.
    float normalFrontL = step(nL.z - 1e-4, nC.z);
    float normalFrontR = step(nR.z + 1e-4, nC.z);
    float normalFrontU = step(nU.z - 1e-4, nC.z);
    float normalFrontD = step(nD.z + 1e-4, nC.z);

    // Depth gate: where the boundary is a silhouette (depth discontinuity),
    // use the depth-front rule; otherwise use the normal-front rule.
    float depthGateL = step(uDepthThreshold, abs(dC - dL));
    float depthGateR = step(uDepthThreshold, abs(dC - dR));
    float depthGateU = step(uDepthThreshold, abs(dC - dU));
    float depthGateD = step(uDepthThreshold, abs(dC - dD));
    float edgeSideL = mix(normalFrontL, depthFrontL, depthGateL);
    float edgeSideR = mix(normalFrontR, depthFrontR, depthGateR);
    float edgeSideU = mix(normalFrontU, depthFrontU, depthGateU);
    float edgeSideD = mix(normalFrontD, depthFrontD, depthGateD);

    // ID suppression: same group AND matching normals → coplanar virtual seam.
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

    // Id-boundary edge: catches coplanar same-normal seams between different
    // outline groups. Use edgeSide (depth-gated) not raw normalFront so
    // depth+id transitions at the same boundary merge on one iso-col.
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
    else if (uDebugMode == 7) outColor = vec3(0.0, max(normalEdge, idEdge), 0.0);

    gl_FragColor = vec4(outColor, 1.0);
  }
`;

export type EdgeDetectionDebugMode =
  | "final"
  | "color"
  | "depth"
  | "normals"
  | "ids"
  | "edges"
  | "depth-edges"
  | "normal-edges";

export const EDGE_DETECTION_DEBUG_MODES: readonly EdgeDetectionDebugMode[] = [
  "final",
  "color",
  "depth",
  "normals",
  "ids",
  "edges",
  "depth-edges",
  "normal-edges"
];

export function edgeDetectionDebugModeIndex(mode: EdgeDetectionDebugMode): number {
  return EDGE_DETECTION_DEBUG_MODES.indexOf(mode);
}

export type EdgeDetectionConfig = {
  colorTexture: THREE.Texture;
  depthTexture: THREE.Texture;
  normalTexture: THREE.Texture;
  idTexture: THREE.Texture;
  resolution: THREE.Vector2Like;
  near: number;
  far: number;
  /** Magnitude of linear-depth difference that counts as a silhouette (default 0.05). */
  depthThreshold?: number;
  /** `1 - dot(n1, n2)` above this value creates a normal edge (default 0.3). */
  normalThreshold?: number;
  /**
   * Two pixels count as "same surface" for id-suppression when
   * `dot(n1, n2) ≥ this`. Default 0.5. Set above 1.0 to disable suppression
   * entirely (all seams draw).
   */
  idSuppressNormalDot?: number;
  /** How much brighter outlined pixels are than their source (default 1.35). */
  outlineBrightness?: number;
  /** 0 = outline disabled (pass through), 1 = full strength (default). */
  outlineMix?: number;
};

export class EdgeDetectionMaterial extends THREE.ShaderMaterial {
  constructor(config: EdgeDetectionConfig) {
    super({
      uniforms: {
        uColorTex: { value: config.colorTexture },
        uDepthTex: { value: config.depthTexture },
        uNormalTex: { value: config.normalTexture },
        uIdTex: { value: config.idTexture },
        uResolution: {
          value: new THREE.Vector2(config.resolution.x, config.resolution.y)
        },
        uNear: { value: config.near },
        uFar: { value: config.far },
        uDepthThreshold: { value: config.depthThreshold ?? 0.05 },
        uNormalThreshold: { value: config.normalThreshold ?? 0.3 },
        uIdSuppressNormalDot: { value: config.idSuppressNormalDot ?? 0.5 },
        uOutlineBrightness: { value: config.outlineBrightness ?? 1.35 },
        uOutlineMix: { value: config.outlineMix ?? 1.0 },
        uDebugMode: { value: 0 }
      },
      vertexShader: POST_VS,
      fragmentShader: POST_FS,
      depthTest: false
    });
  }

  setResolution(width: number, height: number): void {
    (this.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  setRange(near: number, far: number): void {
    this.uniforms.uNear.value = near;
    this.uniforms.uFar.value = far;
  }

  setDebugMode(mode: EdgeDetectionDebugMode): void {
    this.uniforms.uDebugMode.value = edgeDetectionDebugModeIndex(mode);
  }
}
