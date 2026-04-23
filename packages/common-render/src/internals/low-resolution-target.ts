import * as THREE from "three";
import { OutputUpscaleMaterial } from "./output-upscale-material";

export type LowResolutionTargetInput = {
  lowTargetSamples: number;
  smoothPixelTransitions: boolean;
  outputOverscanLowPixels: number;
};

export type LowResolutionDisplayState = {
  readonly lowRenderWidth: number;
  readonly lowRenderHeight: number;
  readonly contentScaleX: number;
  readonly contentScaleY: number;
  readonly contentOffsetX: number;
  readonly contentOffsetY: number;
  readonly viewportDeviceWidth: number;
  readonly viewportDeviceHeight: number;
};

/**
 * The low-resolution render target that the scene is drawn into, together with
 * the full-screen quad that upscales it onto the device framebuffer. Owns all
 * the display-side layout math (where the overscanned output sits inside the
 * pane, pad sizes, render scale) and exposes it to the viewport core for pan
 * quantization.
 *
 * The output scene is deliberately kept separate from the user scene — callers
 * render their own scene into `getLowTarget()` first, then call
 * `renderUpscaleQuad(...)` to composite it onto the pane.
 */
export class LowResolutionTarget {
  private readonly outputScene: THREE.Scene;
  private readonly outputCamera: THREE.OrthographicCamera;
  private readonly outputMaterial: OutputUpscaleMaterial;
  private readonly outputQuad: THREE.Mesh;
  private readonly outputOverscanLowPixels: number;

  private lowTarget: THREE.WebGLRenderTarget;
  private customOutputSource: THREE.Texture | null = null;

  private _baseRenderScale = 1;
  private _sceneOutputWidth = 1;
  private _sceneOutputHeight = 1;
  private _outputWidth = 1;
  private _outputHeight = 1;
  private _outputPadDeviceX = 0;
  private _outputPadDeviceY = 0;
  private _renderBaseX = 0;
  private _renderBaseY = 0;

  constructor(input: LowResolutionTargetInput) {
    this.outputOverscanLowPixels = input.outputOverscanLowPixels;
    this.lowTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false,
      samples: input.lowTargetSamples
    });
    this.lowTarget.texture.generateMipmaps = false;

    this.outputScene = new THREE.Scene();
    this.outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.outputMaterial = new OutputUpscaleMaterial({
      source: this.lowTarget.texture,
      smoothPixelTransitions: input.smoothPixelTransitions
    });
    this.outputQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outputMaterial);
    this.outputQuad.frustumCulled = false;
    this.outputScene.add(this.outputQuad);
  }

  getLowTarget(): THREE.WebGLRenderTarget {
    return this.lowTarget;
  }

  setLowTarget(next: THREE.WebGLRenderTarget, lowWidth: number, lowHeight: number): void {
    const old = this.lowTarget;
    this.lowTarget = next;
    next.setSize(lowWidth, lowHeight);
    if (!this.customOutputSource) {
      this.outputMaterial.uniforms.uSource.value = this.lowTarget.texture;
    }
    old.dispose();
  }

  setOutputSourceTexture(texture: THREE.Texture | null): void {
    this.customOutputSource = texture;
    this.outputMaterial.uniforms.uSource.value = texture ?? this.lowTarget.texture;
  }

  /** Update low-target size and the sampler uniforms that depend on it. */
  applyControllerState(state: LowResolutionDisplayState, baseRenderScale: number): void {
    this.lowTarget.setSize(state.lowRenderWidth, state.lowRenderHeight);
    (this.outputMaterial.uniforms.uSourceSize.value as THREE.Vector2).set(
      state.lowRenderWidth,
      state.lowRenderHeight
    );
    (this.outputMaterial.uniforms.uContentScale.value as THREE.Vector2).set(
      state.contentScaleX,
      state.contentScaleY
    );
    (this.outputMaterial.uniforms.uContentOffset.value as THREE.Vector2).set(
      state.contentOffsetX,
      state.contentOffsetY
    );
    this.updateDisplayLayout(state, baseRenderScale);
  }

  /**
   * Recompute the on-screen layout of the overscanned output rect. `scale` is
   * the integer render scale (same as `baseRenderScale` in normal operation).
   */
  updateDisplayLayout(state: LowResolutionDisplayState, scale: number): void {
    const safeScale = Math.max(1, scale);
    this._baseRenderScale = safeScale;
    this._sceneOutputWidth = state.lowRenderWidth * safeScale;
    this._sceneOutputHeight = state.lowRenderHeight * safeScale;
    this._outputWidth = (state.lowRenderWidth + this.outputOverscanLowPixels) * safeScale;
    this._outputHeight = (state.lowRenderHeight + this.outputOverscanLowPixels) * safeScale;
    this._outputPadDeviceX = (this._outputWidth - this._sceneOutputWidth) * 0.5;
    this._outputPadDeviceY = (this._outputHeight - this._sceneOutputHeight) * 0.5;
    this._renderBaseX = Math.floor((state.viewportDeviceWidth - this._outputWidth) * 0.5);
    this._renderBaseY = Math.floor((state.viewportDeviceHeight - this._outputHeight) * 0.5);
  }

  setZoomUniforms(zoomStable: number, pivotX: number, pivotY: number): void {
    const zoom = Math.max(1, zoomStable);
    this.outputMaterial.uniforms.uZoom.value = zoom;
    (this.outputMaterial.uniforms.uZoomPivot.value as THREE.Vector2).set(pivotX, pivotY);
    this.outputMaterial.uniforms.uEffectiveScale.value = this._baseRenderScale * zoom;
  }

  renderUpscaleQuad(
    renderer: THREE.WebGLRenderer,
    left: number,
    bottom: number,
    width: number,
    height: number
  ): void {
    renderer.setViewport(left, bottom, width, height);
    renderer.render(this.outputScene, this.outputCamera);
  }

  get baseRenderScale(): number {
    return this._baseRenderScale;
  }

  get sceneOutputWidth(): number {
    return this._sceneOutputWidth;
  }

  get sceneOutputHeight(): number {
    return this._sceneOutputHeight;
  }

  get outputWidth(): number {
    return this._outputWidth;
  }

  get outputHeight(): number {
    return this._outputHeight;
  }

  get outputPadDeviceX(): number {
    return this._outputPadDeviceX;
  }

  get outputPadDeviceY(): number {
    return this._outputPadDeviceY;
  }

  get renderBaseX(): number {
    return this._renderBaseX;
  }

  get renderBaseY(): number {
    return this._renderBaseY;
  }

  dispose(): void {
    this.lowTarget.dispose();
    this.outputQuad.geometry.dispose();
    this.outputMaterial.dispose();
    this.outputScene.remove(this.outputQuad);
  }
}
