import * as THREE from "three";

export type SceneKit = {
  scene: THREE.Scene;
  orbitCamera: THREE.PerspectiveCamera;
  isoCamera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  ambientLight: THREE.AmbientLight;
  directionalLight: THREE.DirectionalLight;
  dispose: () => void;
};

export function createSceneKit(
  width: number,
  height: number,
  dpr: number,
): SceneKit {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2a2a);

  // Orbit (perspective) camera
  const aspect = width / height;
  const orbitCamera = new THREE.PerspectiveCamera(45, aspect, 0.01, 50);
  orbitCamera.position.set(2, 2, 2);
  orbitCamera.lookAt(0, 1, 0);

  // Isometric camera
  const isoSize = 3;
  const isoCamera = new THREE.OrthographicCamera(
    -isoSize * aspect, isoSize * aspect,
    isoSize, -isoSize,
    0.01, 50,
  );
  // Classic isometric angle
  const isoAngle = Math.atan(Math.SQRT1_2); // ~35.264°
  const isoDist = 10;
  isoCamera.position.set(
    isoDist * Math.cos(isoAngle) * Math.cos(Math.PI / 4),
    isoDist * Math.sin(isoAngle),
    isoDist * Math.cos(isoAngle) * Math.sin(Math.PI / 4),
  );
  isoCamera.lookAt(0, 1, 0);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(3, 5, 4);
  directionalLight.castShadow = true;
  scene.add(directionalLight);

  // Ground grid
  const grid = new THREE.GridHelper(10, 10, 0x444444, 0x333333);
  scene.add(grid);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = true;

  const dispose = () => {
    scene.clear();
    renderer.dispose();
    renderer.domElement.remove();
  };

  return {
    scene,
    orbitCamera,
    isoCamera,
    renderer,
    ambientLight,
    directionalLight,
    dispose,
  };
}

export function resizeSceneKit(kit: SceneKit, width: number, height: number) {
  const aspect = width / height;
  kit.orbitCamera.aspect = aspect;
  kit.orbitCamera.updateProjectionMatrix();

  const isoSize = 3;
  kit.isoCamera.left = -isoSize * aspect;
  kit.isoCamera.right = isoSize * aspect;
  kit.isoCamera.updateProjectionMatrix();

  kit.renderer.setSize(width, height);
}
