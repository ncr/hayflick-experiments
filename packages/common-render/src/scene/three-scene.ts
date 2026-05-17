import * as THREE from "three";
import type {
  Scene,
  SceneBoxOptions,
  SceneFloorOptions,
  SceneGridOptions,
  SceneObject,
  ScreenPixelBasis
} from "@common/gameplay";
import type { GeometryValidator } from "./iso-geometry-validator";

// Three.js implementation of the abstract Scene interface that GameModules
// use. Attaches all spawned nodes under `root` so the studio can tear the
// whole game down by removing root from its parent.
//
// `snapWorldToScreenPixel` is the load-bearing piece for stable rendering:
// pass a snap function (see `IsoGameView.snapWorldPointOnGround`) and every
// `SceneObject.setPosition` will quantize (x, z) to the screen pixel grid on
// the ground plane, keeping y unchanged. Without this, a slowly-moving box
// renders subtly differently every frame as its edges fall on different
// low-res texels.

export type CreateThreeSceneOptions = {
  /**
   * Snap a world point (x, y, z) onto the screen pixel grid on the ground
   * plane. Receives the writable output vector and the input coordinates;
   * must return `true` when a snap was produced (the renderer's iso camera
   * needs a ground basis, which doesn't exist in side mode). When omitted
   * or it returns `false`, the unsnapped position is applied.
   *
   * Typical wiring:
   * ```ts
   * const inV = new THREE.Vector3();
   * const outV = new THREE.Vector3();
   * createThreeScene(root, {
   *   snapWorldToScreenPixel: (x, y, z) => {
   *     inV.set(x, y, z);
   *     if (view.snapWorldPointOnGround(inV, outV)) {
   *       return { x: outV.x, y, z: outV.z };
   *     }
   *     return null;
   *   }
   * });
   * ```
   */
  snapWorldToScreenPixel?: (
    x: number,
    y: number,
    z: number
  ) => { x: number; y: number; z: number } | null;
  /**
   * Return the live screen-pixel lattice basis on the ground plane.
   * Typically wired to `IsoGameView.getSnapBasis()`. Used by the
   * gameplay layer's input system to express player motion in screen
   * pixels per second along the iso 2:1 staircase — the only mapping
   * that produces wobble-free diagonal walks under the pixel snap.
   */
  getScreenPixelBasis?: () => ScreenPixelBasis | null;
  /**
   * Construction-time guard on every spawn — called with the primitive's
   * role and XZ dimensions before the geometry is built. The default
   * value when omitted is `undefined` (no validation, generic three.js
   * use cases pass through). Iso-projection consumers should wire
   * {@link isoCleanGeometryValidator}, which throws when sizes don't
   * align to the iso 2:1 stair grid — preventing the user from creating
   * geometry that visibly breaks the staircase outline.
   */
  validateGeometry?: GeometryValidator;
};

type SnapFn = NonNullable<CreateThreeSceneOptions["snapWorldToScreenPixel"]>;

class ThreeSceneObject implements SceneObject {
  constructor(
    private readonly parent: THREE.Object3D,
    private readonly node: THREE.Object3D,
    private readonly resources: ReadonlyArray<{ dispose(): void }>,
    private readonly snap: SnapFn | undefined,
    // World-space y added before snap. For anchor:"bottom" on a box of
    // height sy, this is sy/2 so the caller can pass y=0 and have the
    // bottom face sit on the floor. Always 0 for flat primitives.
    private readonly yOffset: number = 0
  ) {}

  setPosition(x: number, y: number, z: number): void {
    const worldY = y + this.yOffset;
    if (this.snap) {
      const snapped = this.snap(x, worldY, z);
      if (snapped) {
        this.node.position.set(snapped.x, snapped.y, snapped.z);
        return;
      }
    }
    this.node.position.set(x, worldY, z);
  }

  setVisible(visible: boolean): void {
    this.node.visible = visible;
  }

  dispose(): void {
    this.parent.remove(this.node);
    for (const r of this.resources) {
      r.dispose();
    }
  }
}

function boxDimensions(size: SceneBoxOptions["size"]): [number, number, number] {
  if (typeof size === "number") return [size, size, size];
  return [size.x, size.y, size.z];
}

export function createThreeScene(
  root: THREE.Object3D,
  options: CreateThreeSceneOptions = {}
): Scene {
  const snap = options.snapWorldToScreenPixel;
  const getScreenPixelBasis = options.getScreenPixelBasis ?? (() => null);
  const validate = options.validateGeometry;
  return {
    getScreenPixelBasis,
    spawnFloor(opts: SceneFloorOptions): SceneObject {
      validate?.({ role: "floor", xz: { x: opts.size, z: opts.size } });
      const geo = new THREE.PlaneGeometry(opts.size, opts.size);
      const mat = new THREE.MeshStandardMaterial({
        color: opts.color ?? 0x1f2329,
        roughness: 0.95,
        metalness: 0
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      root.add(mesh);
      return new ThreeSceneObject(root, mesh, [geo, mat], snap);
    },

    spawnGrid(opts: SceneGridOptions): SceneObject {
      validate?.({ role: "grid", xz: { x: opts.size, z: opts.size } });
      const divisions = opts.divisions ?? opts.size;
      const color = opts.color ?? 0x6a6558;
      const secondary = opts.secondaryColor ?? opts.color ?? 0x3a3d44;
      const grid = new THREE.GridHelper(opts.size, divisions, color, secondary);
      grid.position.y = 0.001;
      root.add(grid);
      const resources: { dispose(): void }[] = [grid.geometry];
      if (Array.isArray(grid.material)) {
        for (const m of grid.material) resources.push(m);
      } else {
        resources.push(grid.material as THREE.Material);
      }
      return new ThreeSceneObject(root, grid, resources, snap);
    },

    spawnBox(opts: SceneBoxOptions): SceneObject {
      const [sx, sy, sz] = boxDimensions(opts.size);
      validate?.({ role: "box", xz: { x: sx, z: sz } });
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mat = new THREE.MeshStandardMaterial({
        color: opts.color ?? 0xffffff,
        roughness: 0.4,
        metalness: 0.05
      });
      const mesh = new THREE.Mesh(geo, mat);
      const yOffset = opts.anchor === "bottom" ? sy / 2 : 0;
      const obj = new ThreeSceneObject(root, mesh, [geo, mat], snap, yOffset);
      root.add(mesh);
      if (opts.position) {
        obj.setPosition(opts.position.x, opts.position.y, opts.position.z);
      }
      return obj;
    }
  };
}
