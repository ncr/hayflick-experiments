import * as THREE from "three";
import { BUILDING_WALL_SEGMENTS } from "./ao";

// Shader-based AO with GUI-tunable uniforms. Two distinct effects:
//
//   - **Wall AO** (floor + ground only): darken fragments whose XZ position
//     is close to a wall line. Pixel-art "contact line" along every wall
//     base. Sharable wall-segment buffer; strength/radius per-surface.
//
//   - **Box edge AO** (boxes only): darken fragments whose normalised local
//     Y is below `boxEdgeFraction`. Adds a dark contact band at the
//     bottom of every box that sits on something — automatic anchoring.
//     Box geometries need an `aLocalYNormalized` attribute, set by
//     `createTintedBox`.
//
// Both AO contributions are multiplied into `gl_FragColor.rgb` at
// `<colorspace_fragment>` (i.e. before fog), so foggy rooms still see the
// dark contact lines through the haze.

const MAX_WALLS = 16;

function packWallSegments(): THREE.Vector4[] {
  const arr: THREE.Vector4[] = [];
  for (const w of BUILDING_WALL_SEGMENTS) {
    arr.push(new THREE.Vector4(w[0], w[1], w[2], w[3]));
  }
  while (arr.length < MAX_WALLS) {
    arr.push(new THREE.Vector4(0, 0, 0, 0));
  }
  return arr;
}

const WALL_VALUES = packWallSegments();

export type WallAOUniforms = {
  aoWallSegments: { value: THREE.Vector4[] };
  aoWallCount: { value: number };
  aoStrength: { value: number };
  aoRadius: { value: number };
};

export const aoFloorUniforms: WallAOUniforms = {
  aoWallSegments: { value: WALL_VALUES },
  aoWallCount: { value: BUILDING_WALL_SEGMENTS.length },
  aoStrength: { value: 0.65 },
  aoRadius: { value: 0.4 }
};

export const aoGroundUniforms: WallAOUniforms = {
  aoWallSegments: { value: WALL_VALUES },
  aoWallCount: { value: BUILDING_WALL_SEGMENTS.length },
  aoStrength: { value: 0.45 },
  aoRadius: { value: 0.5 }
};

export const aoBoxEdgeUniforms = {
  boxEdgeStrength: { value: 0.22 },
  boxEdgeFraction: { value: 0.18 }
};

const PATCH_FLAG = "aoFragmentPatched";

type AOPatchOptions = {
  /** Pass to enable wall-distance AO (used by floor + ground meshes). */
  wallUniforms?: WallAOUniforms;
  /** Pass true on box materials whose geometry has aLocalYNormalized. */
  useEdgeAO?: boolean;
};

export function patchAOFragment(
  material: THREE.Material,
  opts: AOPatchOptions
): void {
  const haveWall = opts.wallUniforms !== undefined;
  const haveEdge = opts.useEdgeAO === true;
  if (!haveWall && !haveEdge) return;
  if (material.userData[PATCH_FLAG] === true) return;

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous.call(material, shader, renderer);

    if (haveWall) {
      const u = opts.wallUniforms!;
      shader.uniforms.aoWallSegments = u.aoWallSegments;
      shader.uniforms.aoWallCount = u.aoWallCount;
      shader.uniforms.aoStrength = u.aoStrength;
      shader.uniforms.aoRadius = u.aoRadius;

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
         varying vec3 vAOWorldPos;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <fog_vertex>",
        `#include <fog_vertex>
         vAOWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
         varying vec3 vAOWorldPos;
         uniform vec4 aoWallSegments[${MAX_WALLS}];
         uniform int aoWallCount;
         uniform float aoStrength;
         uniform float aoRadius;
         float computeWallAO(vec2 worldXZ) {
           float minDist = 1e6;
           for (int i = 0; i < ${MAX_WALLS}; i++) {
             if (i >= aoWallCount) break;
             vec2 a = aoWallSegments[i].xy;
             vec2 b = aoWallSegments[i].zw;
             vec2 ab = b - a;
             float lenSq = dot(ab, ab);
             float t = lenSq > 0.0 ? clamp(dot(worldXZ - a, ab) / lenSq, 0.0, 1.0) : 0.0;
             vec2 closest = a + t * ab;
             minDist = min(minDist, distance(worldXZ, closest));
           }
           if (minDist >= aoRadius) return 1.0;
           float tt = sqrt(minDist / aoRadius);
           return 1.0 - (1.0 - tt) * aoStrength;
         }`
      );
    }

    if (haveEdge) {
      shader.uniforms.boxEdgeStrength = aoBoxEdgeUniforms.boxEdgeStrength;
      shader.uniforms.boxEdgeFraction = aoBoxEdgeUniforms.boxEdgeFraction;

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
         attribute float aLocalYNormalized;
         varying float vLocalYNorm;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <fog_vertex>",
        `#include <fog_vertex>
         vLocalYNorm = aLocalYNormalized;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
         varying float vLocalYNorm;
         uniform float boxEdgeStrength;
         uniform float boxEdgeFraction;`
      );
    }

    // Multiplier injection point. Both AO contributions stack here.
    const wallApply = haveWall
      ? "ao *= computeWallAO(vAOWorldPos.xz);"
      : "";
    const edgeApply = haveEdge
      ? `float edgeT = smoothstep(0.0, max(0.001, boxEdgeFraction), vLocalYNorm);
         ao *= mix(1.0 - boxEdgeStrength, 1.0, edgeT);`
      : "";
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <colorspace_fragment>",
      `#include <colorspace_fragment>
       {
         float ao = 1.0;
         ${wallApply}
         ${edgeApply}
         gl_FragColor.rgb *= ao;
       }`
    );
  };

  material.userData[PATCH_FLAG] = true;
  material.needsUpdate = true;
}
