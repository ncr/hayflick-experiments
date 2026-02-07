import * as THREE from "three";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

const postVertexShader = `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const postFragmentShader = `
precision highp float;
precision highp int;

uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform sampler2D uNormalTex;
uniform vec2 uResolution;
uniform int uPixelSize;
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uEdgeDarken;
uniform vec3 uDepthEdgeColor;
uniform vec3 uNormalEdgeColor;
uniform float uEdgeColorMix;
uniform float uNear;
uniform float uFar;

in vec2 vUv;
out vec4 outColor;

float linearizeDepth(float rawDepth) {
  float z = rawDepth * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  ivec2 screenSize = ivec2(max(uResolution, vec2(1.0)));
  ivec2 p = ivec2(floor(gl_FragCoord.xy));

  int px = max(uPixelSize, 1);
  ivec2 block = (p / px) * px;
  ivec2 samplePos = block + ivec2(px / 2);

  ivec2 maxPos = screenSize - ivec2(1);
  samplePos = clamp(samplePos, ivec2(0), maxPos);

  vec3 c = texelFetch(uColorTex, samplePos, 0).rgb;

  ivec2 cPos = samplePos;
  ivec2 lPos = clamp(cPos + ivec2(-px, 0), ivec2(0), maxPos);
  ivec2 rPos = clamp(cPos + ivec2(px, 0), ivec2(0), maxPos);
  ivec2 uPos = clamp(cPos + ivec2(0, -px), ivec2(0), maxPos);
  ivec2 dPos = clamp(cPos + ivec2(0, px), ivec2(0), maxPos);

  float dC = linearizeDepth(texelFetch(uDepthTex, cPos, 0).r);
  float dL = linearizeDepth(texelFetch(uDepthTex, lPos, 0).r);
  float dR = linearizeDepth(texelFetch(uDepthTex, rPos, 0).r);
  float dU = linearizeDepth(texelFetch(uDepthTex, uPos, 0).r);
  float dD = linearizeDepth(texelFetch(uDepthTex, dPos, 0).r);

  vec3 nC = texelFetch(uNormalTex, cPos, 0).rgb * 2.0 - 1.0;
  vec3 nL = texelFetch(uNormalTex, lPos, 0).rgb * 2.0 - 1.0;
  vec3 nR = texelFetch(uNormalTex, rPos, 0).rgb * 2.0 - 1.0;
  vec3 nU = texelFetch(uNormalTex, uPos, 0).rgb * 2.0 - 1.0;
  vec3 nD = texelFetch(uNormalTex, dPos, 0).rgb * 2.0 - 1.0;

  float depthFrontL = step(dC, dL);
  float depthFrontR = step(dC, dR);
  float depthFrontU = step(dC, dU);
  float depthFrontD = step(dC, dD);

  float sameL = 1.0 - step(uDepthThreshold, abs(dC - dL));
  float sameR = 1.0 - step(uDepthThreshold, abs(dC - dR));
  float sameU = 1.0 - step(uDepthThreshold, abs(dC - dU));
  float sameD = 1.0 - step(uDepthThreshold, abs(dC - dD));

  float frontL = mix(depthFrontL, 0.0, sameL);
  float frontR = mix(depthFrontR, 1.0, sameR);
  float frontU = mix(depthFrontU, 0.0, sameU);
  float frontD = mix(depthFrontD, 1.0, sameD);

  float depthEdge = max(
    max(step(uDepthThreshold, abs(dC - dL)) * frontL, step(uDepthThreshold, abs(dC - dR)) * frontR),
    max(step(uDepthThreshold, abs(dC - dU)) * frontU, step(uDepthThreshold, abs(dC - dD)) * frontD)
  );

  float normalEdge = max(
    max(step(uNormalThreshold, 1.0 - dot(nC, nL)) * frontL, step(uNormalThreshold, 1.0 - dot(nC, nR)) * frontR),
    max(step(uNormalThreshold, 1.0 - dot(nC, nU)) * frontU, step(uNormalThreshold, 1.0 - dot(nC, nD)) * frontD)
  );

  float edge = max(depthEdge, normalEdge);
  vec3 edgeBase = mix(uNormalEdgeColor, uDepthEdgeColor, depthEdge);
  vec3 darkened = c * uEdgeDarken;
  vec3 shadedEdge = mix(darkened, edgeBase, uEdgeColorMix);
  vec3 finalColor = mix(c, shadedEdge, edge);

  outColor = vec4(finalColor, 1.0);
}
`;

const experiment: ExperimentModule = {
  id: "pixel-outline-post",
  title: "Pixel Outline Post",
  tags: ["threejs", "shader", "postprocess", "outline"],
  init: ({ mount, width, height, dpr }) => {
    const renderer = makeRenderer(width, height, dpr);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x0e1218);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.1;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2f4258);

    const camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 50);

    const key = new THREE.DirectionalLight(0xfff3db, 5.6);
    key.position.set(3, 5, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8ab5ff, 2.2);
    fill.position.set(-4, 2, -3);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0x7a95b3, 1.6));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.MeshStandardMaterial({ color: 0x31445a, roughness: 0.9, metalness: 0.0 })
    );
    ground.rotation.x = -Math.PI * 0.5;
    ground.position.y = -0.8;
    scene.add(ground);

    const objects: THREE.Object3D[] = [];

    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.58, 0.2, 180, 28),
      new THREE.MeshStandardMaterial({ color: 0x4fd0a4, roughness: 0.32, metalness: 0.12 })
    );
    knot.position.set(0.35, 0.82, 0.0);
    scene.add(knot);
    objects.push(knot);

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xf6a53d, roughness: 0.72, metalness: 0.08 })
    );
    box.position.set(-0.35, 0.0, 0.0);
    scene.add(box);
    objects.push(box);

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.58, 36, 24),
      new THREE.MeshStandardMaterial({ color: 0x7f9eff, roughness: 0.22, metalness: 0.02 })
    );
    sphere.position.set(1.15, -0.12, 0.75);
    scene.add(sphere);
    objects.push(sphere);

    const normalMaterial = new THREE.MeshNormalMaterial();

    const mainTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true
    });
    mainTarget.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    mainTarget.depthTexture.format = THREE.DepthFormat;
    mainTarget.depthTexture.minFilter = THREE.NearestFilter;
    mainTarget.depthTexture.magFilter = THREE.NearestFilter;

    const normalTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true
    });

    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: postVertexShader,
      fragmentShader: postFragmentShader,
      uniforms: {
        uColorTex: { value: mainTarget.texture },
        uDepthTex: { value: mainTarget.depthTexture },
        uNormalTex: { value: normalTarget.texture },
        uResolution: { value: new THREE.Vector2(width, height) },
        uPixelSize: { value: 5 },
        uDepthThreshold: { value: 0.12 },
        uNormalThreshold: { value: 0.38 },
        uEdgeDarken: { value: 0.35 },
        uDepthEdgeColor: { value: new THREE.Color(0x000000) },
        uNormalEdgeColor: { value: new THREE.Color(0x000000) },
        uEdgeColorMix: { value: 1.0 },
        uNear: { value: camera.near },
        uFar: { value: camera.far }
      }
    });

    const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
    postScene.add(postQuad);

    const resize = (nextWidth: number, nextHeight: number) => {
      const safeWidth = Math.max(1, Math.floor(nextWidth));
      const safeHeight = Math.max(1, Math.floor(nextHeight));

      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();

      const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
      const bufferWidth = Math.max(1, Math.floor(bufferSize.x));
      const bufferHeight = Math.max(1, Math.floor(bufferSize.y));

      mainTarget.setSize(bufferWidth, bufferHeight);
      normalTarget.setSize(bufferWidth, bufferHeight);
      postMaterial.uniforms.uResolution.value.set(bufferWidth, bufferHeight);
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

    const focusPoint = new THREE.Vector3(0.0, 0.42, 0.0);
    const orbitRadius = 5.3;
    const baseAzimuth = THREE.MathUtils.degToRad(126);
    const baseElevation = THREE.MathUtils.degToRad(34);
    const azimuthArc = THREE.MathUtils.degToRad(5);
    const elevationArc = THREE.MathUtils.degToRad(2);

    let raf = 0;
    const startedAt = performance.now();

    const render = () => {
      const t = (performance.now() - startedAt) / 1000;

      const azimuth = baseAzimuth + Math.sin(t * 0.22) * azimuthArc;
      const elevation = baseElevation + Math.sin(t * 0.17) * elevationArc;
      const planar = Math.cos(elevation) * orbitRadius;
      camera.position.set(
        focusPoint.x + Math.cos(azimuth) * planar,
        focusPoint.y + Math.sin(elevation) * orbitRadius,
        focusPoint.z + Math.sin(azimuth) * planar
      );
      camera.lookAt(focusPoint);

      knot.rotation.x = t * 0.25;
      knot.rotation.y = -t * 0.38;
      box.rotation.y = t * 0.45;
      sphere.position.y = -0.15 + Math.sin(t * 1.35) * 0.12;

      renderer.setRenderTarget(mainTarget);
      renderer.render(scene, camera);

      const prevOverride = scene.overrideMaterial;
      scene.overrideMaterial = normalMaterial;
      renderer.setRenderTarget(normalTarget);
      renderer.render(scene, camera);
      scene.overrideMaterial = prevOverride;

      renderer.setRenderTarget(null);
      renderer.render(postScene, postCamera);

      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();

      scene.remove(ground, knot, box, sphere);
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      knot.geometry.dispose();
      (knot.material as THREE.Material).dispose();
      box.geometry.dispose();
      (box.material as THREE.Material).dispose();
      sphere.geometry.dispose();
      (sphere.material as THREE.Material).dispose();

      postScene.remove(postQuad);
      (postQuad.geometry as THREE.BufferGeometry).dispose();
      postMaterial.dispose();

      normalMaterial.dispose();
      mainTarget.dispose();
      normalTarget.dispose();

      renderer.dispose();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
