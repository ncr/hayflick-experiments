/**
 * How this ECS runs per frame:
 * 1) RAF computes dt and updates world time.
 * 2) InputSystem samples keyboard into InputState.
 * 3) PlayerInputSystem writes Velocity for player-tagged entities.
 * 4) MovementSystem applies dt movement and emits events.
 * 5) EventSystem drains events and logs/debugs them.
 * 6) Save/load key pulses (K/L) run after systems each frame.
 * 7) HUD redraws from current resources and components.
 */

import {
  createEventSystem,
  createInputSystem,
  createMovementSystem,
  createPlayerInputSystem,
  frame,
  KeyboardTracker,
  type DebugMessage,
  type DebugSink,
  type LevelResource,
  type Transform,
  type WorldOptions,
  World
} from "@common/gameplay";

function createDemoLevel(id = "demo-halfplane", version = 1): LevelResource {
  return {
    id,
    version,
    isBlocked(x: number): boolean {
      return x > 5;
    }
  };
}

function createDemoWorldOptions(): WorldOptions {
  return {
    level: createDemoLevel(),
    resolveLevel: (snapshot) => createDemoLevel(snapshot.id, snapshot.version)
  };
}

function round2(value: number): string {
  return value.toFixed(2);
}

function findPlayerTransform(world: World): Transform | null {
  for (const eid of world.queryTransformPlayer()) {
    const transform = world.transforms.get(eid);
    if (transform) {
      return transform;
    }
  }

  return null;
}

function pushDebug(messages: DebugMessage[], text: string, frameId: number): void {
  messages.push({ frame: frameId, message: text });
  if (messages.length > 8) {
    messages.shift();
  }
}

function formatPlayerLine(world: World): string {
  const player = findPlayerTransform(world);
  if (!player) {
    return "Player: <none>";
  }

  return `Player: x=${round2(player.x)} y=${round2(player.y)}`;
}

// Tiny runnable browser demo that exercises movement, collision, and save/load.
export function runEcsFoundationDemo(mount: HTMLElement): () => void {
  mount.style.position = "relative";
  mount.style.background = "#0b1117";
  mount.style.color = "#d8e7f2";
  mount.style.fontFamily = "IBM Plex Mono, SFMono-Regular, Menlo, monospace";

  const world = new World(createDemoWorldOptions());

  // Explicit entity creation (no authoring/prefab layer):
  const player = world.createEntity();
  world.transforms.add(player, { x: 0, y: 0 });
  world.velocities.add(player, { vx: 0, vy: 0 });
  world.playerTags.add(player, true);
  world.persistents.add(player, { kind: "player" });

  const debugMessages: DebugMessage[] = [];
  const debugSink: DebugSink = {
    push(message) {
      pushDebug(debugMessages, message.message, message.frame);
    }
  };

  const keyboard = new KeyboardTracker(window);

  const systems = {
    inputSystem: createInputSystem(keyboard),
    playerInputSystem: createPlayerInputSystem(4),
    movementSystem: createMovementSystem(),
    eventSystem: createEventSystem(debugSink)
  };

  const hud = document.createElement("pre");
  hud.style.margin = "0";
  hud.style.padding = "12px";
  hud.style.fontSize = "13px";
  hud.style.lineHeight = "1.5";
  hud.style.whiteSpace = "pre-wrap";
  mount.appendChild(hud);

  let statusLine = "Ready.";

  function saveNow(): void {
    try {
      world.saveToLocalStorage("ecs_demo_save");
      statusLine = "Saved to localStorage key: ecs_demo_save";
      console.log("[ecs-foundation] save success", formatPlayerLine(world));
      pushDebug(debugMessages, statusLine, world.time.frame);
    } catch (error) {
      statusLine = "Save failed.";
      console.warn("[ecs-foundation] save failed", error);
      pushDebug(debugMessages, statusLine, world.time.frame);
    }
  }

  function loadNow(): void {
    const loaded = world.loadFromLocalStorage("ecs_demo_save");
    if (loaded) {
      statusLine = "Load success.";
      console.log("[ecs-foundation] load success", formatPlayerLine(world));
    } else {
      statusLine = "No valid save found.";
      console.log("[ecs-foundation] load failed: no valid save");
    }
    pushDebug(debugMessages, statusLine, world.time.frame);
  }

  function renderHud(): void {
    const eventTail = debugMessages.slice(-6).map((entry) => `  - ${entry.message}`);

    hud.textContent = [
      "ECS Foundation Demo",
      "Controls: Arrow/WASD move | K save | L load",
      "",
      `Time: t=${round2(world.time.t)} dt=${round2(world.time.dt)} frame=${world.time.frame}`,
      formatPlayerLine(world),
      `Level: ${world.level.id} v${world.level.version} (blocked when x > 5)`,
      `Status: ${statusLine}`,
      "",
      "Recent Events:",
      ...(eventTail.length > 0 ? eventTail : ["  - <none>"])
    ].join("\n");
  }

  let raf = 0;
  let last = performance.now();

  const tick = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;

    frame(world, dt, systems);

    if (world.input.savePressed) {
      saveNow();
    }

    if (world.input.loadPressed) {
      loadNow();
    }

    renderHud();
    raf = requestAnimationFrame(tick);
  };

  renderHud();
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    keyboard.dispose(window);
    hud.remove();

    mount.style.position = "";
    mount.style.background = "";
    mount.style.color = "";
    mount.style.fontFamily = "";
  };
}
