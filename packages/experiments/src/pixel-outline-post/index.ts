import * as THREE from "three";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

const POST_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const POST_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform sampler2D uNormalTex;

uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uPixelSize;
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uEdgeDarken;
uniform float uOutlineDarken;
uniform float uOutlineLightResponse;
uniform float uOutlineSaturationBoost;
uniform float uOutlineProminence;
uniform float uPostDitherStrength;

varying vec2 vUv;

float linearizeDepth(float rawDepth) {
  float z = rawDepth * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec2 clampUv(vec2 uv, vec2 texel) {
  return clamp(uv, texel * 0.5, vec2(1.0) - texel * 0.5);
}

float bayer4x4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float x = q.x;
  float y = q.y;

  if (y < 1.0) {
    if (x < 1.0) return 0.0;
    if (x < 2.0) return 8.0;
    if (x < 3.0) return 2.0;
    return 10.0;
  }
  if (y < 2.0) {
    if (x < 1.0) return 12.0;
    if (x < 2.0) return 4.0;
    if (x < 3.0) return 14.0;
    return 6.0;
  }
  if (y < 3.0) {
    if (x < 1.0) return 3.0;
    if (x < 2.0) return 11.0;
    if (x < 3.0) return 1.0;
    return 9.0;
  }
  if (x < 1.0) return 15.0;
  if (x < 2.0) return 7.0;
  if (x < 3.0) return 13.0;
  return 5.0;
}

void main() {
  vec2 texel = 1.0 / uResolution;
  float stepPx = max(1.0, floor(uPixelSize + 0.5));
  vec2 blockStep = texel * stepPx;

  vec2 block = floor(vUv / blockStep) * blockStep;
  vec2 cUv = clampUv(block + blockStep * 0.5, texel);

  vec2 lUv = clampUv(cUv + vec2(-blockStep.x, 0.0), texel);
  vec2 rUv = clampUv(cUv + vec2(blockStep.x, 0.0), texel);
  vec2 uUv = clampUv(cUv + vec2(0.0, -blockStep.y), texel);
  vec2 dUv = clampUv(cUv + vec2(0.0, blockStep.y), texel);

  vec3 c = texture2D(uColorTex, cUv).rgb;

  float dC = texture2D(uDepthTex, cUv).r;
  float dL = texture2D(uDepthTex, lUv).r;
  float dR = texture2D(uDepthTex, rUv).r;
  float dU = texture2D(uDepthTex, uUv).r;
  float dD = texture2D(uDepthTex, dUv).r;

  float ldC = linearizeDepth(dC);
  float ldL = linearizeDepth(dL);
  float ldR = linearizeDepth(dR);
  float ldU = linearizeDepth(dU);
  float ldD = linearizeDepth(dD);

  vec3 nC = normalize(texture2D(uNormalTex, cUv).rgb * 2.0 - 1.0);
  vec3 nL = normalize(texture2D(uNormalTex, lUv).rgb * 2.0 - 1.0);
  vec3 nR = normalize(texture2D(uNormalTex, rUv).rgb * 2.0 - 1.0);
  vec3 nU = normalize(texture2D(uNormalTex, uUv).rgb * 2.0 - 1.0);
  vec3 nD = normalize(texture2D(uNormalTex, dUv).rgb * 2.0 - 1.0);

  float depthFrontL = step(ldC, ldL);
  float depthFrontR = step(ldC, ldR);
  float depthFrontU = step(ldC, ldU);
  float depthFrontD = step(ldC, ldD);

  float sameL = 1.0 - step(uDepthThreshold, abs(ldC - ldL));
  float sameR = 1.0 - step(uDepthThreshold, abs(ldC - ldR));
  float sameU = 1.0 - step(uDepthThreshold, abs(ldC - ldU));
  float sameD = 1.0 - step(uDepthThreshold, abs(ldC - ldD));

  float frontL = mix(depthFrontL, 0.0, sameL);
  float frontR = mix(depthFrontR, 1.0, sameR);
  float frontU = mix(depthFrontU, 0.0, sameU);
  float frontD = mix(depthFrontD, 1.0, sameD);

  float depthEdge = max(
    max(step(uDepthThreshold, abs(ldC - ldL)) * frontL, step(uDepthThreshold, abs(ldC - ldR)) * frontR),
    max(step(uDepthThreshold, abs(ldC - ldU)) * frontU, step(uDepthThreshold, abs(ldC - ldD)) * frontD)
  );

  float normalEdge = max(
    max(step(uNormalThreshold, 1.0 - dot(nC, nL)) * frontL, step(uNormalThreshold, 1.0 - dot(nC, nR)) * frontR),
    max(step(uNormalThreshold, 1.0 - dot(nC, nU)) * frontU, step(uNormalThreshold, 1.0 - dot(nC, nD)) * frontD)
  );

  float edge = max(depthEdge, normalEdge);
  // Color outlines from the underlying mesh color so each object keeps its hue.
  float colorLuma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float lightMix = mix(0.0, smoothstep(0.02, 0.95, colorLuma), uOutlineLightResponse);
  float shadeFactor = mix(uOutlineDarken, uOutlineDarken + 0.42, lightMix);

  vec3 chromaEdge = mix(vec3(colorLuma), c, uOutlineSaturationBoost);
  vec3 litEdgeColor = clamp(chromaEdge * shadeFactor, 0.0, 1.0);
  vec3 darkened = c * uEdgeDarken;
  vec3 outlined = mix(darkened, litEdgeColor, uOutlineProminence);
  vec3 outColor = mix(c, outlined, edge);

  vec2 blockCoord = floor(vUv / blockStep);
  float bayer = (bayer4x4(blockCoord) + 0.5) / 16.0 - 0.5;
  float luma = dot(outColor, vec3(0.2126, 0.7152, 0.0722));
  float midtones = smoothstep(0.08, 0.55, luma) * (1.0 - smoothstep(0.62, 0.92, luma));
  float ditherMask = (1.0 - edge * 0.9) * midtones;
  outColor = clamp(outColor + vec3(bayer * uPostDitherStrength * ditherMask), 0.0, 1.0);

  gl_FragColor = vec4(outColor, 1.0);
}
`;

function makeGradientMap(bands: number): THREE.DataTexture {
  const steps = Math.max(2, bands);
  const data = new Uint8Array(steps * 4);

  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const value = Math.round((0.18 + t * 0.82) * 255);
    const offset = i * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }

  const gradient = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

function applyRetroDither(material: THREE.MeshToonMaterial, bands: number, strength: number) {
  material.dithering = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uToonDitherBands = { value: Math.max(2.0, bands) };
    shader.uniforms.uToonDitherStrength = { value: strength };
    shader.uniforms.uToonDitherPixelSize = { value: 4.0 };

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <gradientmap_pars_fragment>",
      `
      #ifdef USE_GRADIENTMAP
      uniform sampler2D gradientMap;
      #endif

      uniform float uToonDitherBands;
      uniform float uToonDitherStrength;
      uniform float uToonDitherPixelSize;

      float toonBayer4x4(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        float x = q.x;
        float y = q.y;
        if (y < 1.0) {
          if (x < 1.0) return 0.0;
          if (x < 2.0) return 8.0;
          if (x < 3.0) return 2.0;
          return 10.0;
        }
        if (y < 2.0) {
          if (x < 1.0) return 12.0;
          if (x < 2.0) return 4.0;
          if (x < 3.0) return 14.0;
          return 6.0;
        }
        if (y < 3.0) {
          if (x < 1.0) return 3.0;
          if (x < 2.0) return 11.0;
          if (x < 3.0) return 1.0;
          return 9.0;
        }
        if (x < 1.0) return 15.0;
        if (x < 2.0) return 7.0;
        if (x < 3.0) return 13.0;
        return 5.0;
      }

      vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) {
        float dotNL = clamp(dot(normal, lightDirection) * 0.5 + 0.5, 0.0, 1.0);
        float levels = max(2.0, uToonDitherBands);
        vec2 ditherCell = floor(gl_FragCoord.xy / max(1.0, uToonDitherPixelSize));
        float bayer = (toonBayer4x4(ditherCell) + 0.5) / 16.0 - 0.5;
        float dithered = clamp(dotNL + bayer * uToonDitherStrength, 0.0, 1.0);
        float quantized = floor(dithered * (levels - 1.0) + 0.5) / (levels - 1.0);

        #ifdef USE_GRADIENTMAP
          return vec3(texture2D(gradientMap, vec2(quantized, 0.0)).r);
        #else
          return vec3(quantized);
        #endif
      }
      `
    );
  };
  material.customProgramCacheKey = () => `retroDither_b${bands.toFixed(2)}_s${strength.toFixed(3)}`;
  material.needsUpdate = true;
}

const experiment: ExperimentModule = {
  id: "pixel-outline-post",
  title: "Pixel Outline Post",
  tags: ["threejs", "toon", "outline", "postprocess", "retro"],
  init: ({ mount, width, height, dpr }) => {
    const renderer = makeRenderer(width, height, dpr);
    renderer.setPixelRatio(dpr);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x25364d);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x334963);

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 20);

    const keyLight = new THREE.DirectionalLight(0xfff1d4, 1.15);
    keyLight.position.set(1.7, 2.4, 1.15);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.normalBias = 0.003;
    keyLight.shadow.camera.left = -1.8;
    keyLight.shadow.camera.right = 1.8;
    keyLight.shadow.camera.top = 1.3;
    keyLight.shadow.camera.bottom = -1.3;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 6.0;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x8bb0ff, 0.55);
    fillLight.position.set(-1.5, 1.1, -1.2);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xff9fd2, 0.34);
    rimLight.position.set(0.15, 1.5, -1.9);
    scene.add(rimLight);

    const hemiLight = new THREE.HemisphereLight(0x8ba5bf, 0x1a2533, 0.28);
    scene.add(hemiLight);

    const gradients: THREE.Texture[] = [];
    const toonMaterials: THREE.MeshToonMaterial[] = [];
    const makeToonMaterial = (color: number, bands: number, ditherStrength: number) => {
      const gradientMap = makeGradientMap(bands);
      gradients.push(gradientMap);
      const material = new THREE.MeshToonMaterial({
        color,
        gradientMap,
        toneMapped: true
      });
      applyRetroDither(material, bands, ditherStrength);
      toonMaterials.push(material);
      return material;
    };

    const deskTopY = 0.0;
    const SURFACE_EPSILON = 0.001;
    const geometries: THREE.BufferGeometry[] = [];
    const meshes: THREE.Mesh[] = [];
    const spinData: Array<{ mesh: THREE.Mesh; speed: number }> = [];

    const addMesh = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: THREE.Vector3,
      speed: number,
      castShadow: boolean
    ) => {
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      scene.add(mesh);
      meshes.push(mesh);
      spinData.push({ mesh, speed });
      return mesh;
    };

    const desk = addMesh(
      new THREE.BoxGeometry(2.2, 0.08, 1.2),
      makeToonMaterial(0x8da7c7, 3, 0.04),
      new THREE.Vector3(0, -0.04, 0),
      0.0,
      false
    );
    desk.frustumCulled = false;

    const centerBox = addMesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.22),
      makeToonMaterial(0xf28a13, 4, 0.075),
      new THREE.Vector3(0, 0.11, 0),
      0.32,
      true
    );

    const torus = addMesh(
      new THREE.TorusKnotGeometry(0.14, 0.045, 120, 18),
      makeToonMaterial(0x74dcb6, 4, 0.085),
      new THREE.Vector3(-0.34, 0.0, -0.08),
      -0.32,
      true
    );

    const sphere = addMesh(
      new THREE.IcosahedronGeometry(0.13, 1),
      makeToonMaterial(0xa6b7ff, 5, 0.07),
      new THREE.Vector3(0.32, 0.0, 0.09),
      0.24,
      true
    );

    const capsule = addMesh(
      new THREE.CapsuleGeometry(0.08, 0.14, 4, 12),
      makeToonMaterial(0xd4db7c, 4, 0.07),
      new THREE.Vector3(-0.1, 0.0, 0.27),
      -0.22,
      true
    );

    const cone = addMesh(
      new THREE.ConeGeometry(0.1, 0.26, 12),
      makeToonMaterial(0xd67bc8, 4, 0.07),
      new THREE.Vector3(0.23, 0.0, 0.25),
      0.18,
      true
    );

    const shapesOnDesk = [centerBox, torus, sphere, capsule, cone];
    for (const mesh of shapesOnDesk) {
      mesh.geometry.computeBoundingBox();
      const bounds = mesh.geometry.boundingBox;
      if (!bounds) {
        continue;
      }
      mesh.position.y = deskTopY - bounds.min.y + SURFACE_EPSILON;
    }

    const colorTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false
    });
    colorTarget.texture.generateMipmaps = false;
    colorTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);

    const normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false
    });
    normalTarget.texture.generateMipmaps = false;

    const normalMaterial = new THREE.MeshNormalMaterial();

    const postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorTex: { value: colorTarget.texture },
        uDepthTex: { value: colorTarget.depthTexture },
        uNormalTex: { value: normalTarget.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uPixelSize: { value: 4.0 },
        uDepthThreshold: { value: 0.12 },
        uNormalThreshold: { value: 0.24 },
        uEdgeDarken: { value: 0.28 },
        uOutlineDarken: { value: 0.24 },
        uOutlineLightResponse: { value: 1.0 },
        uOutlineSaturationBoost: { value: 1.9 },
        uOutlineProminence: { value: 0.98 },
        uPostDitherStrength: { value: 0.0 }
      },
      vertexShader: POST_VERTEX_SHADER,
      fragmentShader: POST_FRAGMENT_SHADER
    });

    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
    postQuad.frustumCulled = false;
    postScene.add(postQuad);

    const orbitTarget = centerBox.position.clone();
    const orbitRadius = 1.1;
    const orbitHeight = 0.72;
    let orbitAngle = 0.0;

    const resize = (nextWidth: number, nextHeight: number) => {
      const safeWidth = Math.max(1, Math.floor(nextWidth));
      const safeHeight = Math.max(1, Math.floor(nextHeight));

      renderer.setSize(safeWidth, safeHeight, true);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();

      const drawingBufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
      const targetWidth = Math.max(1, Math.floor(drawingBufferSize.x));
      const targetHeight = Math.max(1, Math.floor(drawingBufferSize.y));
      colorTarget.setSize(targetWidth, targetHeight);
      normalTarget.setSize(targetWidth, targetHeight);
      postMaterial.uniforms.uResolution.value.set(targetWidth, targetHeight);
    };

    resize(width, height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(mount);

    const clock = new THREE.Clock();
    let elapsed = 0;
    let raf = 0;

    const render = () => {
      const dt = clock.getDelta();
      elapsed += dt;

      orbitAngle += dt * 0.32;
      camera.position.set(
        Math.cos(orbitAngle) * orbitRadius,
        orbitHeight + Math.sin(elapsed * 0.25) * 0.05,
        Math.sin(orbitAngle) * orbitRadius
      );
      camera.lookAt(orbitTarget);

      for (const item of spinData) {
        if (item.speed !== 0) {
          item.mesh.rotation.y += dt * item.speed;
        }
      }

      scene.overrideMaterial = null;
      renderer.setRenderTarget(colorTarget);
      renderer.clear();
      renderer.render(scene, camera);

      scene.overrideMaterial = normalMaterial;
      renderer.setRenderTarget(normalTarget);
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = null;

      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(postScene, postCamera);

      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scene.overrideMaterial = null;

      for (const mesh of meshes) {
        scene.remove(mesh);
      }
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const material of toonMaterials) {
        material.dispose();
      }
      for (const gradient of gradients) {
        gradient.dispose();
      }

      scene.remove(keyLight, fillLight, rimLight, hemiLight);

      normalMaterial.dispose();
      colorTarget.dispose();
      normalTarget.dispose();

      postQuad.geometry.dispose();
      postMaterial.dispose();
      postScene.remove(postQuad);

      renderer.dispose();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
