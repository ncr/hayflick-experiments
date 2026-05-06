import * as THREE from "three";

// Per-fragment height-falloff fog. Patches a material's fog code via
// `onBeforeCompile` so density at world Y is
//   `effDensity = baseDensity * exp(-(worldY - floor) * scale)`
// — full at the floor, vanishing high up. Set scale = 0 to fall back to
// uniform fog (matches plain THREE.FogExp2 behaviour).
//
// Every patched material shares the same THREE.Uniform objects, so updating
// `fogHeightUniforms.fogHeightScale.value` propagates to all of them in one
// place — no per-material sweep needed.

export const fogHeightUniforms = {
  fogHeightFloor: { value: 0.0 },
  fogHeightScale: { value: 0.55 }
};

const PATCH_FLAG = "heightFogPatched";

export function patchHeightFog(material: THREE.Material): void {
  if (material.userData[PATCH_FLAG] === true) return;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous.call(material, shader, renderer);
    shader.uniforms.fogHeightFloor = fogHeightUniforms.fogHeightFloor;
    shader.uniforms.fogHeightScale = fogHeightUniforms.fogHeightScale;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
       varying float vWorldY;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <fog_vertex>",
      `#include <fog_vertex>
       vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
       varying float vWorldY;
       uniform float fogHeightFloor;
       uniform float fogHeightScale;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <fog_fragment>",
      `#ifdef USE_FOG
        float heightFactor = exp(-max(0.0, vWorldY - fogHeightFloor) * fogHeightScale);
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * heightFactor * heightFactor * vFogDepth * vFogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth) * heightFactor;
        #endif
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogFactor, 0.0, 1.0));
      #endif`
    );
  };
  material.userData[PATCH_FLAG] = true;
  material.needsUpdate = true;
}
