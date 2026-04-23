import * as THREE from "three";
import type {
  SharedScissorFrameContext,
  SharedScissorPane,
  SharedScissorPaneRect
} from "./shared-scissor-stage";
import { SharedScissorStage } from "./shared-scissor-stage";

export type PerspectivePaneConfig = {
  /** Stage to host this pane. The pane auto-registers on construction. */
  stage: SharedScissorStage;
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

/**
 * A pane that renders an arbitrary three.js scene+camera pair into its
 * element's rect on a {@link SharedScissorStage}. No pixel-perfect pipeline —
 * use {@link PixelPerfectPane} if you want iso-2:1 integer upscaling.
 */
export class PerspectivePane implements SharedScissorPane {
  readonly id: string;
  readonly element: HTMLElement;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly clearColor?: number;
  private readonly clearAlpha: number;
  private readonly autoResizePerspectiveCamera: boolean;
  private readonly resizeHook?: (rect: SharedScissorPaneRect) => void;
  private readonly beforeRenderHook?: (
    frame: SharedScissorFrameContext,
    rect: SharedScissorPaneRect
  ) => void;

  constructor(config: PerspectivePaneConfig) {
    this.id = config.id;
    this.element = config.element;
    this.scene = config.scene;
    this.camera = config.camera;
    this.clearColor = config.clearColor;
    this.clearAlpha = config.clearAlpha ?? 1;
    this.autoResizePerspectiveCamera = config.autoResizePerspectiveCamera ?? true;
    this.resizeHook = config.onResize;
    this.beforeRenderHook = config.beforeRender;
    config.stage.registerPane(this);
  }

  render(frame: SharedScissorFrameContext, rect: SharedScissorPaneRect): void {
    const renderer = frame.renderer;
    this.beforeRenderHook?.(frame, rect);
    renderer.setScissor(rect.deviceLeft, rect.deviceBottom, rect.deviceWidth, rect.deviceHeight);
    renderer.setViewport(
      rect.deviceViewportLeft,
      rect.deviceViewportBottom,
      rect.deviceWidthUnclipped,
      rect.deviceHeightUnclipped
    );
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
