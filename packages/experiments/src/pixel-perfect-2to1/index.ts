import * as THREE from "three";
import type { ExperimentModule } from "../runtime/types";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  FIXED_RENDER_WIDTH,
  GRID_SIZE,
  ORTHO_HEIGHT,
  PIXEL_SNAP
} from "./config";

const experiment: ExperimentModule = {
  id: "pixel-perfect-2to1",
  title: "Pixel Perfect 2:1",
  tags: ["pixel", "isometric", "rendering"],
  init: ({ mount, width, height }) => {
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, true);
    renderer.setClearColor(0x0b0f14, 1);
    renderer.domElement.style.imageRendering = "pixelated";
    mount.appendChild(renderer.domElement);
    mount.style.display = "flex";
    mount.style.alignItems = "center";
    mount.style.justifyContent = "center";
    mount.style.background = "#0b0f14";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const cameraTarget = new THREE.Vector3(0, 0, 0);
    const cameraViewTarget = new THREE.Vector3();

    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(4, 8, 4);
    scene.add(keyLight);

    const floorGroup = new THREE.Group();
    scene.add(floorGroup);

    const tileGeometry = new THREE.BoxGeometry(1, 0.04, 1);
    const tileWhite = new THREE.MeshLambertMaterial({ color: 0xf0f2f5 });
    const tileGray = new THREE.MeshLambertMaterial({ color: 0xc2c8cf });

    for (let x = 0; x < GRID_SIZE; x += 1) {
      for (let z = 0; z < GRID_SIZE; z += 1) {
        const material = (x + z) % 2 === 0 ? tileWhite : tileGray;
        const tile = new THREE.Mesh(tileGeometry, material);
        tile.position.set(
          x - GRID_SIZE * 0.5 + 0.5,
          -0.02,
          z - GRID_SIZE * 0.5 + 0.5
        );
        floorGroup.add(tile);
      }
    }

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const boxMaterials = [
      new THREE.MeshLambertMaterial({ color: 0x9bb7ff }),
      new THREE.MeshLambertMaterial({ color: 0xffb36a }),
      new THREE.MeshLambertMaterial({ color: 0x8be0a2 }),
      new THREE.MeshLambertMaterial({ color: 0xd8a7ff })
    ];

    const boxes: THREE.Mesh[] = [];
    const addBox = (x: number, y: number, z: number, colorIndex: number) => {
      const mesh = new THREE.Mesh(
        boxGeometry,
        boxMaterials[colorIndex % boxMaterials.length]
      );
      mesh.position.set(x, y, z);
      scene.add(mesh);
      boxes.push(mesh);
    };

    addBox(-3, 0.5, -2, 0);
    addBox(-1, 0.5, 2, 1);
    addBox(2, 0.5, -1, 2);
    addBox(3, 0.5, 3, 3);
    addBox(0, 1.5, 0, 0);

    const colorTarget = new THREE.WebGLRenderTarget(
      FIXED_RENDER_WIDTH,
      FIXED_RENDER_HEIGHT,
      {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        stencilBuffer: false
      }
    );
    colorTarget.texture.generateMipmaps = false;

    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: colorTarget.texture })
    );
    postQuad.frustumCulled = false;
    postScene.add(postQuad);

    const updateCameraProjection = (nextWidth: number, nextHeight: number) => {
      const aspect = nextWidth / nextHeight;
      const halfHeight = ORTHO_HEIGHT * 0.5;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    };

    const resize = (nextWidth: number, nextHeight: number) => {
      const safeWidth = Math.max(1, Math.floor(nextWidth));
      const safeHeight = Math.max(1, Math.floor(nextHeight));
      const scale = Math.max(
        1,
        Math.floor(
          Math.min(
            safeWidth / FIXED_RENDER_WIDTH,
            safeHeight / FIXED_RENDER_HEIGHT
          )
        )
      );
      const targetWidth = FIXED_RENDER_WIDTH * scale;
      const targetHeight = FIXED_RENDER_HEIGHT * scale;
      renderer.setSize(targetWidth, targetHeight, false);
      updateCameraProjection(FIXED_RENDER_WIDTH, FIXED_RENDER_HEIGHT);
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

    let raf = 0;
    const render = () => {
      const horizontal = Math.cos(CAMERA_PITCH);
      const dir = new THREE.Vector3(
        Math.sin(CAMERA_YAW) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(CAMERA_YAW) * horizontal
      );

      cameraViewTarget.copy(cameraTarget);
      if (PIXEL_SNAP > 0) {
        const worldUnitsPerPixel = ORTHO_HEIGHT / FIXED_RENDER_HEIGHT;
        const snap = worldUnitsPerPixel * PIXEL_SNAP;
        cameraViewTarget.x = Math.round(cameraViewTarget.x / snap) * snap;
        cameraViewTarget.z = Math.round(cameraViewTarget.z / snap) * snap;
      }

      camera.position.copy(cameraViewTarget).addScaledVector(dir, CAMERA_DISTANCE);
      camera.lookAt(cameraViewTarget);
      camera.updateProjectionMatrix();

      renderer.setRenderTarget(colorTarget);
      renderer.clear();
      renderer.render(scene, camera);

      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(postScene, postCamera);

      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();

      mount.style.display = "";
      mount.style.alignItems = "";
      mount.style.justifyContent = "";
      mount.style.background = "";

      boxes.forEach((mesh) => scene.remove(mesh));
      scene.remove(floorGroup);
      scene.remove(ambient, keyLight);

      tileGeometry.dispose();
      tileWhite.dispose();
      tileGray.dispose();
      boxGeometry.dispose();
      boxMaterials.forEach((material) => material.dispose());
      colorTarget.dispose();

      postQuad.geometry.dispose();
      (postQuad.material as THREE.Material).dispose();
      postScene.remove(postQuad);

      renderer.dispose();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
