import * as THREE from "three";

export function makeRenderer(width: number, height: number, dpr: number): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  return renderer;
}
