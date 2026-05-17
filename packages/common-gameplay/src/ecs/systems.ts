import type { DebugSink, EID, InputState } from "./types";
import { World } from "./world";

export type System = (world: World) => void;

export type SystemPipeline = {
  inputSystem: System;
  controlledInputSystem: System;
  movementSystem: System;
  meshSyncSystem: System;
  eventSystem: System;
};

// Input tracking is intentionally tiny and explicit.
// Keyboard state is captured by DOM events, then sampled by InputSystem.
export class KeyboardTracker {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const code = event.code;

    if (!this.held.has(code)) {
      this.pressed.add(code);
    }

    this.held.add(code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.held.delete(event.code);
  };

  constructor(target: Window) {
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  consumePressed(code: string): boolean {
    const hasPress = this.pressed.has(code);
    if (hasPress) {
      this.pressed.delete(code);
    }
    return hasPress;
  }

  dispose(target: Window): void {
    target.removeEventListener("keydown", this.onKeyDown);
    target.removeEventListener("keyup", this.onKeyUp);
    this.held.clear();
    this.pressed.clear();
  }
}

// InputSystem reads keyboard and writes input resource each frame.
export function createInputSystem(keyboard: KeyboardTracker): System {
  return (world: World) => {
    const nextInput: InputState = {
      up: keyboard.isHeld("ArrowUp") || keyboard.isHeld("KeyW"),
      down: keyboard.isHeld("ArrowDown") || keyboard.isHeld("KeyS"),
      left: keyboard.isHeld("ArrowLeft") || keyboard.isHeld("KeyA"),
      right: keyboard.isHeld("ArrowRight") || keyboard.isHeld("KeyD"),
      savePressed: keyboard.consumePressed("KeyK"),
      loadPressed: keyboard.consumePressed("KeyL")
    };

    world.input.up = nextInput.up;
    world.input.down = nextInput.down;
    world.input.left = nextInput.left;
    world.input.right = nextInput.right;
    world.input.savePressed = nextInput.savePressed;
    world.input.loadPressed = nextInput.loadPressed;
  };
}

/**
 * Screen-pixel lattice basis on the ground plane. Same shape as
 * `ScreenPixelBasis` in the scene module; duplicated here so the
 * gameplay layer's input system has no dependency on the scene module's
 * geometry adapter beyond a structural type.
 */
export type PlayerInputPixelBasis = {
  centerX: number;
  centerZ: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
};

/**
 * The iso 2:1 input mapping (in `createControlledInputSystem`) scales the
 * y component of input by 0.5, so a diagonal A+W direction normalizes to
 * `(aDir, bDir) = (2/√5, 1/√5)` on the screen-pixel lattice. Re-exported
 * as named constants so the smoothness math + tests can pin them.
 */
export const ISO_INPUT_DIAGONAL_A_RATE = 2 / Math.sqrt(5);  // ≈ 0.894
export const ISO_INPUT_DIAGONAL_B_RATE = 1 / Math.sqrt(5);  // ≈ 0.447

/**
 * The lowest speed (in screen px/sec) at which iso 2:1 motion still looks
 * fluid — defined as "the dominant (`a`) axis advances at least one snap
 * cell per frame at `targetFps`". Below this, snap-cell crossings happen
 * multiple frames apart and the eye reads the motion as discrete ticks.
 *
 * - `mode: "a-fluid"` (default): `a` advances ≥ 1 px/frame; you may still
 *   see a tick every-other-frame on `b`. Smooth-enough cardinal feel.
 * - `mode: "stair-per-frame"`: both axes advance ≥ 1 px/frame, so every
 *   visible move is a complete (2, 1) stair. Twice as fast as `a-fluid`.
 *
 * This is a *recommendation*, not a hard floor. Slow motion is sometimes
 * desirable (stealth, paused world); the trade-off is visible discreteness.
 * Consumers can apply this as a knob `min`, a system-level clamp, or just
 * an editor warning.
 */
export function recommendedMinPxPerSecForIso(
  options: { targetFps?: number; mode?: "a-fluid" | "stair-per-frame" } = {}
): number {
  const fps = options.targetFps ?? 60;
  const mode = options.mode ?? "a-fluid";
  const rate =
    mode === "stair-per-frame"
      ? ISO_INPUT_DIAGONAL_B_RATE
      : ISO_INPUT_DIAGONAL_A_RATE;
  return fps / rate;
}

/**
 * ControlledInputSystem — maps WASD/arrows to velocity for every entity
 * with a `Controlled` component. Each entity carries its own `speed`
 * (number, or a getter for live-knob tracking). Speed is interpreted in
 * screen pixels per second on the iso lattice; below the iso smoothness
 * floor (`recommendedMinPxPerSecForIso`) the system clamps up so visible
 * motion stays fluid regardless of what the knob says. Games that need
 * to go below the floor (paused world, stealth crawl) attach their own
 * input system instead of using this one.
 *
 * `pixelBasis` is a getter (recompute each frame — basis tracks camera
 * yaw / zoom). May return null in poses with no ground basis (side
 * mode); the system falls back to the world-axis path in that case.
 */
export function createControlledInputSystem(
  pixelBasis?: () => PlayerInputPixelBasis | null
): System {
  const smoothnessFloor = recommendedMinPxPerSecForIso();
  return (world: World) => {
    const { up, down, left, right } = world.input;

    const inputX = (right ? 1 : 0) - (left ? 1 : 0);
    const inputY = (up ? 1 : 0) - (down ? 1 : 0);

    let aDir = 0;
    let bDir = 0;
    let dx = 0;
    let dy = 0;
    const basis = pixelBasis ? pixelBasis() : null;

    if (inputX !== 0 || inputY !== 0) {
      if (basis) {
        // Map input onto the (a, b) screen-pixel lattice with iso 2:1
        // ratio: scale the y component to half of x so a combined input
        // traces a clean (2, 1) direction — the iso staircase angle —
        // instead of a 1:1 (45°) screen diagonal. Single-cardinal input
        // stays pure horizontal or pure vertical on screen.
        aDir = inputX;
        bDir = -inputY * 0.5;
        const len = Math.hypot(aDir, bDir);
        aDir /= len;
        bDir /= len;
      } else {
        dx = inputX;
        dy = inputY;
        const length = Math.hypot(dx, dy);
        dx /= length;
        dy /= length;
      }
    }

    for (const eid of world.queryTransformControlled()) {
      const controlled = world.controlled.get(eid);
      if (!controlled) {
        continue;
      }

      const rawSpeed =
        typeof controlled.speed === "function"
          ? controlled.speed()
          : controlled.speed;
      // Below the iso smoothness floor, the dominant axis advances less
      // than one screen-pixel per frame, so motion ticks one axis at a
      // time with visible gaps. The engine clamps so games never have to
      // know about this constraint. (Engine quirk = engine's problem.)
      const s = rawSpeed > 0 ? Math.max(rawSpeed, smoothnessFloor) : 0;

      if (!world.velocities.has(eid)) {
        world.velocities.add(eid, { vx: 0, vy: 0 });
      }
      const velocity = world.velocities.get(eid);
      if (!velocity) {
        continue;
      }

      if (inputX === 0 && inputY === 0) {
        velocity.vx = 0;
        velocity.vy = 0;
      } else if (basis) {
        velocity.vx = (aDir * basis.ux + bDir * basis.vx) * s;
        velocity.vy = (aDir * basis.uz + bDir * basis.vz) * s;
      } else {
        velocity.vx = dx * s;
        velocity.vy = dy * s;
      }
    }
  };
}

// MovementSystem applies dt-scaled velocity and performs level collision checks.
export function createMovementSystem(): System {
  return (world: World) => {
    const dt = world.time.dt;

    for (const eid of world.queryTransformVelocity()) {
      const transform = world.transforms.get(eid);
      const velocity = world.velocities.get(eid);
      if (!transform || !velocity) {
        continue;
      }

      const nextX = transform.x + velocity.vx * dt;
      const nextY = transform.y + velocity.vy * dt;

      if (world.level.isBlocked(nextX, nextY)) {
        world.events.emit({ type: "BumpedWall", e: eid });
        continue;
      }

      if (nextX !== transform.x || nextY !== transform.y) {
        transform.x = nextX;
        transform.y = nextY;
        world.events.emit({ type: "Moved", e: eid });
      }
    }
  };
}

function formatEventMessage(frame: number, eid: EID, type: "Moved" | "BumpedWall"): string {
  return `[frame ${frame}] ${type} e=${eid}`;
}

// EventSystem is the explicit drain point for per-frame events.
export function createEventSystem(debugSink?: DebugSink): System {
  return (world: World) => {
    const drained = world.events.drain();

    for (const event of drained) {
      const message = formatEventMessage(world.time.frame, event.e, event.type);
      console.log(message);

      if (debugSink) {
        debugSink.push({ frame: world.time.frame, message });
      }
    }
  };
}

// MeshSyncSystem copies each entity's ground-plane transform into its
// bound SceneObject. With `anchor: "bottom"` on the mesh, passing y=0
// puts the bottom face on the floor — entities live in 2D (x, y on the
// ground), and the renderer handles the vertical resting position.
export function createMeshSyncSystem(): System {
  return (world: World) => {
    for (const eid of world.queryTransformMesh()) {
      const transform = world.transforms.get(eid);
      const mesh = world.meshes.get(eid);
      if (!transform || !mesh) {
        continue;
      }
      mesh.setPosition(transform.x, 0, transform.y);
    }
  };
}

// Per-frame entrypoint: update Time then run systems in fixed order.
export function frame(world: World, dt: number, systems: SystemPipeline): void {
  world.time.dt = dt;
  world.time.t += dt;
  world.time.frame += 1;

  systems.inputSystem(world);
  systems.controlledInputSystem(world);
  systems.movementSystem(world);
  systems.meshSyncSystem(world);
  systems.eventSystem(world);
}
