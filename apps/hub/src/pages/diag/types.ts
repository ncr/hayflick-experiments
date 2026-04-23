export type DiagSceneContext = {
  mount: HTMLElement;
  width: number;
  height: number;
  slug: string;
};

export type DiagSceneModule = {
  init(ctx: DiagSceneContext): Promise<() => void> | (() => void);
};

/**
 * Imperative handle exposed on `window.__diag` by each scene, for Playwright
 * specs to drive the scene deterministically.
 *
 * Scenes are free to expose additional slug-specific methods, but every scene
 * must at minimum expose `forceFrame` and a `getState` snapshot so the harness
 * can assert on both pixels and internal state.
 */
export type DiagHandle = {
  forceFrame(nFrames?: number): void;
  getLowResSize(): { width: number; height: number } | null;
  getRenderScale(): number | null;
  getPose(): { targetX: number; targetZ: number; yawIndex: number; zoom: number } | null;
  setPose?(pose: { targetX?: number; targetZ?: number; yawIndex?: number; zoom?: number }): void;
  setOutlineDebugMode?(mode: string): void;
};

declare global {
  interface Window {
    __diag?: DiagHandle;
  }
}
