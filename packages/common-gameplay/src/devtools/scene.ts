// Three-agnostic scene primitives a GameModule uses to put geometry on
// screen. The studio supplies an implementation (the three adapter lives
// in @common/render); game code itself never imports three.

export type Vec3 = { x: number; y: number; z: number };

export type SceneFloorOptions = {
  size: number;
  color?: number;
};

export type SceneGridOptions = {
  size: number;
  divisions?: number;
  color?: number;
  secondaryColor?: number;
};

export type SceneBoxOptions = {
  size: number | Vec3;
  color?: number;
  position?: Vec3;
};

export interface SceneObject {
  setPosition(x: number, y: number, z: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Screen-pixel lattice basis on the ground plane (game x/y = world x/z).
 *
 *   centerX/Z    world XZ point at NDC (0, 0)
 *   (ux, uz)     world XZ delta for +1 screen pixel right
 *   (vx, vz)     world XZ delta for +1 screen pixel down
 *
 * Why this basis (and not a "right, forward" world-axis one): in iso 2:1
 * the on-screen vertical is foreshortened by cos π/6, so input mapped
 * to (right, forward) unit vectors makes the `b` snap-coord accumulate
 * ~0.866× the rate of `a`. Independent rounding then drifts the
 * trajectory off any clean stair line — the visible "wobble" on
 * diagonals. Driving motion in this lattice basis directly keeps `a`
 * and `b` in lockstep, so diagonal input walks a clean Bresenham iso
 * 2:1 staircase.
 *
 * Returns null when no ground basis exists (e.g. side mode).
 */
export type ScreenPixelBasis = {
  centerX: number;
  centerZ: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
};

export interface Scene {
  spawnFloor(options: SceneFloorOptions): SceneObject;
  spawnGrid(options: SceneGridOptions): SceneObject;
  spawnBox(options: SceneBoxOptions): SceneObject;
  /**
   * Live screen-pixel lattice basis on the ground plane. Recomputed each
   * call — tracks camera yaw / zoom / pose changes. Returns null when no
   * ground basis exists.
   */
  getScreenPixelBasis(): ScreenPixelBasis | null;
}
