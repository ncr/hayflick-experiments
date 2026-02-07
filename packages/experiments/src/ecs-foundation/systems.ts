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

// PlayerInputSystem maps intent to velocity for player-tagged entities.
export function createPlayerInputSystem(speed = 4): System {
  return (world: World) => {
    const { up, down, left, right } = world.input;

    let dx = 0;
    let dy = 0;

    if (up) dy += 1;
    if (down) dy -= 1;
    if (left) dx -= 1;
    if (right) dx += 1;

    const length = Math.hypot(dx, dy);
    if (length > 0) {
      dx /= length;
      dy /= length;
    }

    const vx = dx * speed;
    const vy = dy * speed;

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
