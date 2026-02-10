import * as THREE from "three";
import { makeRenderer } from "@common/render_legacy";
import type { ExperimentModule } from "../runtime/types";

const vertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
varying vec2 vUv;
uniform float uTime;

void main() {
  vec2 p = vUv - 0.5;
  float wave = 0.5 + 0.5 * sin(12.0 * p.x + uTime * 1.7);
  vec3 base = mix(vec3(0.03, 0.09, 0.16), vec3(0.13, 0.78, 0.62), wave);
  float ring = smoothstep(0.24, 0.23, abs(length(p) - 0.22));
  gl_FragColor = vec4(base + ring * vec3(0.96, 0.86, 0.44), 1.0);
}
`;

const experiment: ExperimentModule = {
  id: "shader-playground",
  title: "Shader Playground",
  tags: ["shader", "threejs", "rendering"],
  init: ({ mount, width, height, dpr }) => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.z = 1.3;

    const renderer = makeRenderer(width, height, dpr);
    mount.appendChild(renderer.domElement);

    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }
      },
      vertexShader,
      fragmentShader
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    let raf = 0;
    const start = performance.now();

    const render = () => {
      material.uniforms.uTime.value = (performance.now() - start) / 1000;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
