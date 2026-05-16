import type { DebugSink, EID, InputState } from "./types";
import { World } from "./world";

export type System = (world: World) => void;

export type SystemPipeline = {
  inputSystem: System;
  playerInputSystem: System;
  movementSystem: System;
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
 * The iso 2:1 input mapping (in `createPlayerInputSystem`) scales the y
 * component of input by 0.5, so a diagonal A+W direction normalizes to
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
 * PlayerInputSystem — maps WASD/arrows to velocity for player-tagged entities.
 *
 * `speed` (constant or getter) is interpreted by `pixelBasis`:
 *   - **With** `pixelBasis`: speed is **screen pixels per second** along
 *     whichever direction the input maps to. Diagonal input (e.g. A+W)
 *     is shaped so that on-screen motion follows the iso 2:1 staircase
 *     direction (Δa = 2·Δb), eliminating the diagonal wobble caused by
 *     foreshortening. This is the right mode for pixel-perfect iso games.
 *   - **Without** `pixelBasis`: speed is **world units per second** along
 *     world XZ. Diagonal input is a 45° unit vector in world XZ. Use
 *     only for non-pixel-snapped scenes or unit tests.
 *
 * `pixelBasis` is a getter (recompute each frame — basis tracks camera
 * yaw / zoom). It may return null in poses with no ground basis (side
 * mode); the system falls back to the world-axis path in that case.
 */
export function createPlayerInputSystem(
  speed: number | (() => number) = 4,
  pixelBasis?: () => PlayerInputPixelBasis | null
): System {
  const getSpeed = typeof speed === "function" ? speed : () => speed;
  return (world: World) => {
    const { up, down, left, right } = world.input;

    const inputX = (right ? 1 : 0) - (left ? 1 : 0);
    const inputY = (up ? 1 : 0) - (down ? 1 : 0);
    const s = getSpeed();

    let vx = 0;
    let vy = 0;

    if (inputX !== 0 || inputY !== 0) {
      const basis = pixelBasis ? pixelBasis() : null;
      if (basis) {
        // Map input onto the (a, b) screen-pixel lattice with iso 2:1
        // ratio: scale the y component to half of x so a combined input
        // traces a clean (2, 1) direction — the iso staircase angle —
        // instead of a 1:1 (45°) screen diagonal. Single-cardinal input
        // stays pure horizontal or pure vertical on screen.
        //
        // After normalize, a diagonal direction = (ISO_INPUT_DIAGONAL_A_RATE,
        // ISO_INPUT_DIAGONAL_B_RATE) = (2/√5, 1/√5). The smoothness threshold
        // in `recommendedMinPxPerSecForIso` is derived from these rates.
        let aDir = inputX;
        let bDir = -inputY * 0.5;
        const len = Math.hypot(aDir, bDir);
        aDir /= len;
        bDir /= len;
        vx = (aDir * basis.ux + bDir * basis.vx) * s;
        vy = (aDir * basis.uz + bDir * basis.vz) * s;
      } else {
        let dx = inputX;
        let dy = inputY;
        const length = Math.hypot(dx, dy);
        dx /= length;
        dy /= length;
        vx = dx * s;
        vy = dy * s;
      }
    }

    for (const eid of world.queryTransformPlayer()) {
      if (!world.velocities.has(eid)) {
        world.velocities.add(eid, { vx: 0, vy: 0 });
      }

      const velocity = world.velocities.get(eid);
      if (!velocity) {
        continue;
      }

      velocity.vx = vx;
      velocity.vy = vy;
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

// Per-frame entrypoint: update Time then run systems in fixed order.
export function frame(world: World, dt: number, systems: SystemPipeline): void {
  world.time.dt = dt;
  world.time.t += dt;
  world.time.frame += 1;

  systems.inputSystem(world);
  systems.playerInputSystem(world);
  systems.movementSystem(world);
  systems.eventSystem(world);
}
