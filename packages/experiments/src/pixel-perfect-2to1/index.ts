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
    const panRight = new THREE.Vector3();
    const panForward = new THREE.Vector3();
    const panDelta = new THREE.Vector3();
    const dragDelta = new THREE.Vector2();

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

    let yawIndex = 0;
    let zoomTarget = 1;
    let zoomCurrent = 1;
    let dragActive = false;
    let lastClientX = 0;
    let lastClientY = 0;
    let renderScale = 1;
    let outputWidth = FIXED_RENDER_WIDTH;
    let outputHeight = FIXED_RENDER_HEIGHT;
    let panRemainderX = 0;
    let panRemainderY = 0;
    let keyPanX = 0;
    let keyPanY = 0;
    let keyPanActive = false;

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
      ) * 2;
      renderScale = scale;
      const targetWidth = FIXED_RENDER_WIDTH * scale;
      const targetHeight = FIXED_RENDER_HEIGHT * scale;
      outputWidth = targetWidth;
      outputHeight = targetHeight;
      renderer.setSize(targetWidth, targetHeight, true);
      renderer.domElement.style.width = `${targetWidth}px`;
      renderer.domElement.style.height = `${targetHeight}px`;
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

    const pixelsPerUnitFromZoom = (value: number) =>
      (value * FIXED_RENDER_HEIGHT) / ORTHO_HEIGHT;
    const zoomFromPixelsPerUnit = (value: number) =>
      (value * ORTHO_HEIGHT) / FIXED_RENDER_HEIGHT;

    const applyPan = (deltaX: number, deltaY: number) => {
      const worldUnitsPerPixel = ORTHO_HEIGHT / zoomCurrent / FIXED_RENDER_HEIGHT;
      const yaw = CAMERA_YAW + yawIndex * (Math.PI * 0.5);
      const horizontal = Math.cos(CAMERA_PITCH);
      const forward = new THREE.Vector3(
        Math.sin(yaw) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yaw) * horizontal
      ).normalize();
      panRight.copy(forward).cross(new THREE.Vector3(0, 1, 0)).normalize();
      panForward.copy(panRight).cross(forward).normalize();
      panRight.y = 0;
      panForward.y = 0;
      if (panRight.lengthSq() > 0.000001) {
        panRight.normalize();
      }
      if (panForward.lengthSq() > 0.000001) {
        panForward.normalize();
      }

      panRemainderX += deltaX / renderScale;
      panRemainderY += deltaY / renderScale;
      const stepX = Math.trunc(panRemainderX);
      const stepY = Math.trunc(panRemainderY);
      panRemainderX -= stepX;
      panRemainderY -= stepY;
      if (stepX === 0 && stepY === 0) {
        return;
      }

      panDelta.set(0, 0, 0);
      panDelta.addScaledVector(panRight, -stepX * worldUnitsPerPixel);
      panDelta.addScaledVector(panForward, -stepY * worldUnitsPerPixel);
      cameraTarget.add(panDelta);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      dragActive = true;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragActive) {
        return;
      }
      dragDelta.set(event.clientX - lastClientX, event.clientY - lastClientY);
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      applyPan(dragDelta.x, dragDelta.y);
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!dragActive) {
        return;
      }
      dragActive = false;
      renderer.domElement.releasePointerCapture(event.pointerId);
      event.preventDefault();
    };

    const handleWheel = (event: WheelEvent) => {
      const step = event.deltaY > 0 ? -32 : 32;
      const currentPPU = pixelsPerUnitFromZoom(zoomTarget);
      const nextPPU = THREE.MathUtils.clamp(currentPPU + step, 32, 256);
      zoomTarget = zoomFromPixelsPerUnit(nextPPU);
      zoomCurrent = zoomTarget;
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyQ") {
        yawIndex -= 1;
        event.preventDefault();
      } else if (event.code === "KeyE") {
        yawIndex += 1;
        event.preventDefault();
      } else if (event.code === "KeyW") {
        keyPanY = -1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyS") {
        keyPanY = 1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyA") {
        keyPanX = -1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyD") {
        keyPanX = 1;
        keyPanActive = true;
        event.preventDefault();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "KeyW" || event.code === "KeyS") {
        keyPanY = 0;
      } else if (event.code === "KeyA" || event.code === "KeyD") {
        keyPanX = 0;
      }
      keyPanActive = keyPanX !== 0 || keyPanY !== 0;
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerUp);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    let raf = 0;
    const render = () => {
      const yaw = CAMERA_YAW + yawIndex * (Math.PI * 0.5);
      zoomCurrent = zoomTarget;

      const horizontal = Math.cos(CAMERA_PITCH);
      const dir = new THREE.Vector3(
        Math.sin(yaw) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yaw) * horizontal
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
      camera.zoom = zoomCurrent;
      camera.updateProjectionMatrix();

      renderer.setRenderTarget(colorTarget);
      renderer.clear();
      renderer.render(scene, camera);

      if (keyPanActive) {
        applyPan(keyPanX, keyPanY);
      }

      renderer.setRenderTarget(null);
      renderer.clear();
      const offsetX = (panRemainderX * renderScale) / (outputWidth * 0.5);
      const offsetY = (-panRemainderY * renderScale) / (outputHeight * 0.5);
      postQuad.position.set(offsetX, offsetY, 0);
      renderer.render(postScene, postCamera);

      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerUp);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);

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
