import * as THREE from "three";
import { pitchForPixelView, type PixelSnapMode, type PixelView } from "../pixel-perfect-types";

export type IsoCameraInput = {
  viewMode: PixelView;
  cameraYaw: number;
  cameraDistance: number;
};

/**
 * The ortho camera for a pixel-perfect iso view, together with the screen↔world
 * plumbing the viewport core needs for pan quantization, zoom anchoring, and
 * ground snaps.
 *
 * Responsibilities:
 * - own the `THREE.OrthographicCamera` and its target
 * - set pose from a target + a fractional yaw turn count
 * - set the projection volume from a low-res frame size and a zoom-out factor
 * - derive the screen→world basis (one low-res pixel in world units) via either
 *   a ground-plane raycast (iso/top-down) or the camera's local axes (side
 *   mode, where the ground plane is parallel to the view direction)
 */
export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;
  readonly cameraTarget = new THREE.Vector3(0, 0, 0);
  readonly viewMode: PixelView;
  readonly baseYaw: number;
  readonly cameraDistance: number;
  readonly pitchRadians: number;

  readonly screenRightWorld = new THREE.Vector3();
  readonly screenDownWorld = new THREE.Vector3();
  readonly centerGround = new THREE.Vector3();

  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraBasisRight = new THREE.Vector3();
  private readonly cameraBasisUp = new THREE.Vector3();
  private readonly cameraBasisBack = new THREE.Vector3();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly rightGround = new THREE.Vector3();
  private readonly downGround = new THREE.Vector3();

  constructor(input: IsoCameraInput) {
    this.viewMode = input.viewMode;
    this.baseYaw = input.cameraYaw;
    this.cameraDistance = input.cameraDistance;
    this.pitchRadians = pitchForPixelView(input.viewMode);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  }

  /**
   * Apply the camera position + lookAt from the current target and a fractional
   * number of quarter-turns around the vertical axis. Clamps target.y to 0 for
   * non-side modes.
   */
  applyPoseFromTarget(animatedYawTurns: number): void {
    if (this.viewMode !== "side" && Math.abs(this.cameraTarget.y) > 1e-9) {
      this.cameraTarget.y = 0;
    }
    const yaw = this.baseYaw + animatedYawTurns * (Math.PI * 0.5);
    const horizontal = Math.cos(this.pitchRadians);
    this.cameraDirection.set(
      Math.sin(yaw) * horizontal,
      Math.sin(this.pitchRadians),
      Math.cos(yaw) * horizontal
    );
    this.camera.position.copy(this.cameraTarget).addScaledVector(
      this.cameraDirection,
      this.cameraDistance
    );
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld(true);
  }

  applyProjection(input: {
    orthoHeight: number;
    aspect: number;
    zoomOutFactor: number;
    verticalBias: number;
  }): void {
    const h = input.orthoHeight / Math.max(1e-6, input.zoomOutFactor);
    const bias = input.verticalBias;
    this.camera.left = -h * 0.5 * input.aspect;
    this.camera.right = h * 0.5 * input.aspect;
    this.camera.top = h * (1 - bias);
    this.camera.bottom = -h * bias;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Refresh `screenRightWorld` / `screenDownWorld` / `centerGround` so that
   * one low-res pixel maps to a known world-space delta. Iso/top-down use a
   * ground-plane raycast; side mode derives the basis from the camera's local
   * axes (the ground plane is parallel to the view direction, so the raycast
   * is degenerate).
   */
  updateScreenToWorld(lowRenderWidth: number, lowRenderHeight: number): void {
    if (this.viewMode === "side") {
      this.computeCameraBasisScreenToWorld(lowRenderWidth, lowRenderHeight);
      this.centerGround.copy(this.cameraTarget);
      return;
    }

    const ndcStepX = 2 / lowRenderWidth;
    const ndcStepY = 2 / lowRenderHeight;

    this.pointerNdc.set(0, 0);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasCenter =
      this.raycaster.ray.intersectPlane(this.groundPlane, this.centerGround) !== null;
    this.pointerNdc.set(ndcStepX, 0);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasRight =
      this.raycaster.ray.intersectPlane(this.groundPlane, this.rightGround) !== null;
    this.pointerNdc.set(0, -ndcStepY);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasDown =
      this.raycaster.ray.intersectPlane(this.groundPlane, this.downGround) !== null;

    if (hasCenter && hasRight && hasDown) {
      this.screenRightWorld.subVectors(this.rightGround, this.centerGround);
      this.screenDownWorld.subVectors(this.downGround, this.centerGround);
      return;
    }

    this.computeCameraBasisScreenToWorld(lowRenderWidth, lowRenderHeight);
  }

  private computeCameraBasisScreenToWorld(lowRenderWidth: number, lowRenderHeight: number): void {
    this.camera.matrixWorld.extractBasis(
      this.cameraBasisRight,
      this.cameraBasisUp,
      this.cameraBasisBack
    );
    const worldUnitsPerPixelX =
      (this.camera.right - this.camera.left) / Math.max(1, lowRenderWidth);
    const worldUnitsPerPixelY =
      (this.camera.top - this.camera.bottom) / Math.max(1, lowRenderHeight);
    this.screenRightWorld.copy(this.cameraBasisRight).multiplyScalar(worldUnitsPerPixelX);
    this.screenDownWorld.copy(this.cameraBasisUp).multiplyScalar(-worldUnitsPerPixelY);
  }

  /** Raycast NDC coords onto the Y=0 ground plane. Returns false if parallel. */
  worldAtNdc(ndcX: number, ndcY: number, out: THREE.Vector3): boolean {
    this.pointerNdc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) !== null;
  }

  /** Snap `world` to the nearest/floor/ceil cell of the screen-pixel lattice on Y=0. */
  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode: PixelSnapMode
  ): boolean {
    if (this.viewMode === "side") {
      return false;
    }
    const ux = this.screenRightWorld.x;
    const uz = this.screenRightWorld.z;
    const vx = this.screenDownWorld.x;
    const vz = this.screenDownWorld.z;
    const wx = world.x - this.centerGround.x;
    const wz = world.z - this.centerGround.z;
    const det = ux * vz - uz * vx;
    if (Math.abs(det) < 1e-8) {
      return false;
    }
    const a = (wx * vz - wz * vx) / det;
    const b = (wz * ux - wx * uz) / det;
    const qa = quantizeSnap(a, mode);
    const qb = quantizeSnap(b, mode);
    out.set(
      this.centerGround.x + ux * qa + vx * qb,
      world.y,
      this.centerGround.z + uz * qa + vz * qb
    );
    return true;
  }
}

function quantizeSnap(value: number, mode: PixelSnapMode): number {
  switch (mode) {
    case "floor":
      return Math.floor(value);
    case "ceil":
      return Math.ceil(value);
    case "nearest":
    default:
      return Math.round(value);
  }
}
