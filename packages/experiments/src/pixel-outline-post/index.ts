import * as THREE from "three";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

const TOON_VERTEX_SHADER = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const TOON_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uLightDir;
uniform float uBands;
uniform float uAmbient;
uniform float uDitherStrength;
uniform float uRimStrength;

varying vec3 vNormalW;
varying vec3 vWorldPos;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 normalW = normalize(vNormalW);
  vec3 lightDir = normalize(-uLightDir);
  float ndotl = max(dot(normalW, lightDir), 0.0);

  // Subtle retro dither before quantization.
  float dither = (hash12(floor(gl_FragCoord.xy)) - 0.5) * uDitherStrength;
  float lit = clamp(ndotl + dither, 0.0, 1.0);

  float levels = max(2.0, uBands);
  float toon = floor(lit * (levels - 1.0) + 0.5) / (levels - 1.0);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float rim = pow(1.0 - max(dot(normalW, viewDir), 0.0), 2.0) * uRimStrength;

  float lightTerm = clamp(uAmbient + toon * (1.0 - uAmbient), 0.0, 1.0);
  vec3 color = uColor * lightTerm + vec3(rim);
  gl_FragColor = vec4(color, 1.0);
}
`;

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
uniform vec3 uDepthEdgeColor;
uniform vec3 uNormalEdgeColor;

varying vec2 vUv;

float linearizeDepth(float rawDepth) {
  float z = rawDepth * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec2 clampUv(vec2 uv, vec2 texel) {
  return clamp(uv, texel * 0.5, vec2(1.0) - texel * 0.5);
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
  vec3 edgeBase = mix(uNormalEdgeColor, uDepthEdgeColor, depthEdge);
  vec3 darkened = c * uEdgeDarken;
  vec3 outlined = mix(darkened, edgeBase, 0.7);
  vec3 outColor = mix(c, outlined, edge);

  gl_FragColor = vec4(outColor, 1.0);
}
`;

const experiment: ExperimentModule = {
  id: "pixel-outline-post",
  title: "Pixel Outline Post",
  tags: ["threejs", "toon", "outline", "postprocess", "retro"],
  init: ({ mount, width, height, dpr }) => {
    const renderer = makeRenderer(width, height, dpr);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x25364d);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x334963);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 20);

    const lightDirection = new THREE.Vector3(0.5, 1.0, 0.65).normalize();

    const toonMaterials: THREE.ShaderMaterial[] = [];
    const makeToonMaterial = (color: number, bands = 4, ditherStrength = 0.12, ambient = 0.24, rimStrength = 0.08) => {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uLightDir: { value: lightDirection.clone() },
          uBands: { value: bands },
          uAmbient: { value: ambient },
          uDitherStrength: { value: ditherStrength },
          uRimStrength: { value: rimStrength }
        },
        vertexShader: TOON_VERTEX_SHADER,
        fragmentShader: TOON_FRAGMENT_SHADER
      });
      toonMaterials.push(material);
      return material;
    };

    const geometries: THREE.BufferGeometry[] = [];
    const meshes: THREE.Mesh[] = [];
    const shadowMeshes: THREE.Mesh[] = [];
    const shadowMaterials: THREE.MeshBasicMaterial[] = [];
    const spinData: Array<{
      mesh: THREE.Mesh;
      speed: number;
      phase: number;
      bob: number;
      baseY: number;
      shadow: THREE.Mesh | null;
      shadowScaleX: number;
      shadowScaleZ: number;
      shadowOpacity: number;
    }> = [];

    const addMesh = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: THREE.Vector3,
      speed: number,
      bob: number,
      phase: number,
      shadow?: { scaleX: number; scaleZ: number; opacity: number }
    ) => {
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      scene.add(mesh);
      meshes.push(mesh);

      let shadowMesh: THREE.Mesh | null = null;
      if (shadow) {
        const shadowGeometry = new THREE.PlaneGeometry(1, 1);
        geometries.push(shadowGeometry);

        const shadowMaterial = new THREE.MeshBasicMaterial({
          color: 0x0a0f17,
          transparent: true,
          opacity: shadow.opacity,
          depthWrite: false,
          toneMapped: false
        });
        shadowMaterials.push(shadowMaterial);

        shadowMesh = new THREE.Mesh(shadowGeometry, shadowMaterial);
        shadowMesh.rotation.x = -Math.PI * 0.5;
        shadowMesh.position.set(position.x, 0.002, position.z);
        shadowMesh.scale.set(shadow.scaleX, shadow.scaleZ, 1.0);
        shadowMesh.renderOrder = 1;
        scene.add(shadowMesh);
        meshes.push(shadowMesh);
        shadowMeshes.push(shadowMesh);
      }

      spinData.push({
        mesh,
        speed,
        phase,
        bob,
        baseY: position.y,
        shadow: shadowMesh,
        shadowScaleX: shadow?.scaleX ?? 0,
        shadowScaleZ: shadow?.scaleZ ?? 0,
        shadowOpacity: shadow?.opacity ?? 0
      });
      return mesh;
    };

    const deskTopY = 0.0;

    const desk = addMesh(
      new THREE.BoxGeometry(2.2, 0.08, 1.2),
      makeToonMaterial(0x8da7c7, 3, 0.04, 0.35, 0.0),
      new THREE.Vector3(0, -0.04, 0),
      0.0,
      0.0,
      0.0
    );
    desk.frustumCulled = false;

    const centerBox = addMesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.22),
      makeToonMaterial(0xf28a13, 4, 0.1, 0.22, 0.04),
      new THREE.Vector3(0, 0.11, 0),
      0.3,
      0.008,
      0.2,
      { scaleX: 0.34, scaleZ: 0.28, opacity: 0.3 }
    );

    addMesh(
      new THREE.TorusKnotGeometry(0.14, 0.045, 120, 18),
      makeToonMaterial(0x74dcb6, 4, 0.14, 0.22, 0.1),
      new THREE.Vector3(-0.36, 0.22, -0.05),
      -0.32,
      0.02,
      1.3,
      { scaleX: 0.38, scaleZ: 0.3, opacity: 0.28 }
    );

    addMesh(
      new THREE.IcosahedronGeometry(0.13, 1),
      makeToonMaterial(0xa6b7ff, 5, 0.1, 0.22, 0.06),
      new THREE.Vector3(0.3, 0.18, 0.08),
      0.26,
      0.012,
      2.0,
      { scaleX: 0.33, scaleZ: 0.27, opacity: 0.26 }
    );

    addMesh(
      new THREE.CapsuleGeometry(0.08, 0.14, 4, 12),
      makeToonMaterial(0xd4db7c, 4, 0.1, 0.2, 0.06),
      new THREE.Vector3(-0.1, 0.16, 0.28),
      -0.22,
      0.012,
      0.7,
      { scaleX: 0.28, scaleZ: 0.23, opacity: 0.24 }
    );

    addMesh(
      new THREE.ConeGeometry(0.1, 0.26, 12),
      makeToonMaterial(0xd67bc8, 4, 0.12, 0.2, 0.05),
      new THREE.Vector3(0.22, 0.18, 0.26),
      0.2,
      0.012,
      2.8,
      { scaleX: 0.31, scaleZ: 0.24, opacity: 0.24 }
    );

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
        uEdgeDarken: { value: 0.34 },
        uDepthEdgeColor: { value: new THREE.Color(0x05070b) },
        uNormalEdgeColor: { value: new THREE.Color(0x04050a) }
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
    const orbitRadius = 1.08;
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

      orbitAngle += dt * 0.34;
      camera.position.set(Math.cos(orbitAngle) * orbitRadius, orbitHeight, Math.sin(orbitAngle) * orbitRadius);
      camera.lookAt(orbitTarget);

      for (const item of spinData) {
        if (item.speed !== 0) {
          item.mesh.rotation.y += dt * item.speed;
        }
        if (item.bob > 0) {
          item.mesh.position.y = item.baseY + Math.sin(elapsed * 1.15 + item.phase) * item.bob;
        }
        if (item.shadow) {
          const heightAboveDesk = Math.max(0.0, item.mesh.position.y - deskTopY);
          const drift = heightAboveDesk * 0.28;
          item.shadow.position.set(
            item.mesh.position.x - lightDirection.x * drift,
            deskTopY + 0.002,
            item.mesh.position.z - lightDirection.z * drift
          );

          const spread = 1.0 + heightAboveDesk * 1.5;
          item.shadow.scale.set(item.shadowScaleX * spread, item.shadowScaleZ * spread, 1.0);

          const shadowMaterial = item.shadow.material as THREE.MeshBasicMaterial;
          shadowMaterial.opacity = Math.max(0.08, item.shadowOpacity - heightAboveDesk * 0.55);
        }
      }

      for (const shadow of shadowMeshes) {
        shadow.visible = true;
      }
      scene.overrideMaterial = null;
      renderer.setRenderTarget(colorTarget);
      renderer.clear();
      renderer.render(scene, camera);

      for (const shadow of shadowMeshes) {
        shadow.visible = false;
      }
      scene.overrideMaterial = normalMaterial;
      renderer.setRenderTarget(normalTarget);
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = null;
      for (const shadow of shadowMeshes) {
        shadow.visible = true;
      }

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
      for (const material of shadowMaterials) {
        material.dispose();
      }

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
