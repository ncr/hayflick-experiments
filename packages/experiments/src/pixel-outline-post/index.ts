import * as THREE from "three";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

const SHOW_DEBUG = true;

const experiment: ExperimentModule = {
  id: "pixel-outline-post",
  title: "Pixel Outline Post",
  tags: ["threejs", "camera", "composition"],
  init: ({ mount, width, height, dpr }) => {
    const renderer = makeRenderer(width, height, dpr);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x334863);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.05, 10);

    // Soft neutral lights so the box color reads clearly.
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(0.8, 1.4, 1.2);
    scene.add(key);

    // 2m x 1m desk surface (40mm thick), centered at world origin.
    const deskThickness = 0.04;
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, deskThickness, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x8ea7c3, roughness: 0.85, metalness: 0.0 })
    );
    desk.position.set(0, 0, 0);
    scene.add(desk);

    // Orange box: 20cm cube, centered on desk surface center.
    const boxSize = 0.2;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(boxSize, boxSize, boxSize),
      new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.6, metalness: 0.0 })
    );
    box.position.set(0, deskThickness * 0.5 + boxSize * 0.5, 0);
    scene.add(box);

    // Camera: 0.5m from box center, looking down at ~30 degrees.
    const target = box.position.clone();
    const distance = 0.5;
    const downAngle = THREE.MathUtils.degToRad(30);
    const vertical = Math.sin(downAngle) * distance;
    const horizontal = Math.cos(downAngle) * distance;
    camera.position.set(target.x, target.y + vertical, target.z + horizontal);
    camera.lookAt(target);

    mount.style.position = "relative";
    const debugOverlay = document.createElement("div");
    debugOverlay.style.position = "absolute";
    debugOverlay.style.inset = "0";
    debugOverlay.style.pointerEvents = "none";
    debugOverlay.style.display = SHOW_DEBUG ? "block" : "none";

    const vLine = document.createElement("div");
    vLine.style.position = "absolute";
    vLine.style.left = "50%";
    vLine.style.top = "0";
    vLine.style.bottom = "0";
    vLine.style.width = "1px";
    vLine.style.background = "rgba(255, 0, 0, 0.6)";

    const hLine = document.createElement("div");
    hLine.style.position = "absolute";
    hLine.style.top = "50%";
    hLine.style.left = "0";
    hLine.style.right = "0";
    hLine.style.height = "1px";
    hLine.style.background = "rgba(255, 0, 0, 0.6)";

    const label = document.createElement("div");
    label.style.position = "absolute";
    label.style.left = "8px";
    label.style.bottom = "8px";
    label.style.color = "#ff8b8b";
    label.style.background = "rgba(0, 0, 0, 0.45)";
    label.style.padding = "2px 6px";
    label.style.borderRadius = "4px";
    label.style.font = "11px IBM Plex Mono, monospace";

    debugOverlay.appendChild(vLine);
    debugOverlay.appendChild(hLine);
    debugOverlay.appendChild(label);
    mount.appendChild(debugOverlay);

    const resize = (nextWidth: number, nextHeight: number) => {
      const safeWidth = Math.max(1, Math.floor(nextWidth));
      const safeHeight = Math.max(1, Math.floor(nextHeight));

      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
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
      camera.lookAt(target);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);

      const ndc = target.clone().project(camera);
      if (SHOW_DEBUG) {
        label.textContent = `box NDC x:${ndc.x.toFixed(3)} y:${ndc.y.toFixed(3)}`;
      }

      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      debugOverlay.remove();

      scene.remove(desk, box);
      desk.geometry.dispose();
      (desk.material as THREE.Material).dispose();
      box.geometry.dispose();
      (box.material as THREE.Material).dispose();

      renderer.dispose();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
