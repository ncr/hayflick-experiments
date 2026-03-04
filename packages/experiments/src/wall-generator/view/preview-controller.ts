import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SceneKit } from "./scene-setup";
import type { PreviewMode } from "../ui/state";

export type PreviewController = {
  setMode: (mode: PreviewMode) => void;
  getActiveCamera: () => THREE.Camera;
  update: () => void;
  dispose: () => void;
};

export function createPreviewController(
  kit: SceneKit,
): PreviewController {
  let mode: PreviewMode = "orbit";

  const controls = new OrbitControls(kit.orbitCamera, kit.renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  function setMode(newMode: PreviewMode) {
    mode = newMode;
    controls.enabled = mode === "orbit";
  }

  function getActiveCamera(): THREE.Camera {
    return mode === "orbit" ? kit.orbitCamera : kit.isoCamera;
  }

  function update() {
    if (mode === "orbit") {
      controls.update();
    }
  }

  function dispose() {
    controls.dispose();
  }

  return { setMode, getActiveCamera, update, dispose };
}
