import * as THREE from "three";
import type {
  SharedScissorFrameContext,
  SharedScissorPane,
  SharedScissorPaneRect
} from "./shared-scissor-stage";

export type ThreeSceneScissorPaneConfig = {
  id: string;
  element: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.Camera;
  clearColor?: number;
  clearAlpha?: number;
  autoResizePerspectiveCamera?: boolean;
  onResize?: (rect: SharedScissorPaneRect) => void;
  beforeRender?: (frame: SharedScissorFrameContext, rect: SharedScissorPaneRect) => void;
};

export class ThreeSceneScissorPane implements SharedScissorPane {
  readonly id: string;
  readonly element: HTMLElement;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly clearColor?: number;
  private readonly clearAlpha: number;
  private readonly autoResizePerspectiveCamera: boolean;
  private readonly resizeHook?: (rect: SharedScissorPaneRect) => void;
  private readonly beforeRenderHook?: (frame: SharedScissorFrameContext, rect: SharedScissorPaneRect) => void;

  constructor(config: ThreeSceneScissorPaneConfig) {
    this.id = config.id;
    this.element = config.element;
    this.scene = config.scene;
    this.camera = config.camera;
    this.clearColor = config.clearColor;
    this.clearAlpha = config.clearAlpha ?? 1;
    this.autoResizePerspectiveCamera = config.autoResizePerspectiveCamera ?? true;
    this.resizeHook = config.onResize;
    this.beforeRenderHook = config.beforeRender;
  }

  render(frame: SharedScissorFrameContext, rect: SharedScissorPaneRect): void {
    const renderer = frame.renderer;
    this.beforeRenderHook?.(frame, rect);
    renderer.setScissor(rect.deviceLeft, rect.deviceBottom, rect.deviceWidth, rect.deviceHeight);
    renderer.setViewport(rect.deviceLeft, rect.deviceBottom, rect.deviceWidth, rect.deviceHeight);
    if (this.clearColor != null) {
      renderer.setClearColor(this.clearColor, this.clearAlpha);
      renderer.clear(true, true, true);
    }
    renderer.render(this.scene, this.camera);
  }

  onResize(rect: SharedScissorPaneRect): void {
    if (this.autoResizePerspectiveCamera && this.camera instanceof THREE.PerspectiveCamera) {
      const width = Math.max(1, rect.cssWidth);
      const height = Math.max(1, rect.cssHeight);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.resizeHook?.(rect);
  }
}

