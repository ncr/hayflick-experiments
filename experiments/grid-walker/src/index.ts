import {
  createEventSystem,
  createInputSystem,
  createMovementSystem,
  createPlayerInputSystem,
  recommendedMinPxPerSecForIso,
  type GameModule
} from "@common/gameplay";

const FLOOR_SIZE = 20;
// World XZ sizes for game props must be multiples of 1/32 wu (= 1 horizontal
// screen pixel at the iso projection ratio) so silhouette edges rasterize
// to integer pixel counts. For a clean 2:1 staircase outline (no mixed
// 2-wide / 3-wide treads), pick multiples of 2/32 = 0.0625 wu — one whole
// stair step. PLAYER_SIZE = 1 wu = 32 H × 16 V px = 16 perfect (2,1) steps.
const PLAYER_SIZE = 1;
const PLAYER_HEIGHT = PLAYER_SIZE / 2;

const gridWalker: GameModule = {
  id: "grid-walker",
  title: "Grid Walker",
  description: "Tiny ECS demo: arrow keys move a player on a flat tile floor.",

  create({ scene, world, keyboard, debug, knobs }) {
    // Speed is in **screen pixels per second** (the scene supplies an iso
    // pixel basis, so the input system reads `speed` in that unit).
    //
    // Floor at the smoothness threshold (≈67 px/s @ 60fps): below this the
    // a-axis advances < 1 px/frame on diagonals, so the box ticks one axis
    // at a time with visible gaps instead of walking a connected stair.
    // Round up to step=10 → min 70.
    const SMOOTH_MIN = Math.ceil(recommendedMinPxPerSecForIso() / 10) * 10;
    const speedKnob = knobs.number("player.speed", {
      min: SMOOTH_MIN,
      max: 240,
      default: 80,
      step: 10
    });
    const showGridKnob = knobs.toggle("debug.showGrid", { default: true });

    const grid = scene.spawnGrid({
      size: FLOOR_SIZE,
      color: 0x6a6558,
      secondaryColor: 0x3a3d44
    });
    const floor = scene.spawnFloor({ size: FLOOR_SIZE, color: 0x1f2329 });
    const player = scene.spawnBox({
      size: PLAYER_SIZE,
      color: 0xd97706,
      position: { x: 0, y: PLAYER_HEIGHT, z: 0 }
    });

    const playerEid = world.createEntity();
    world.transforms.add(playerEid, { x: 0, y: 0 });
    world.velocities.add(playerEid, { vx: 0, vy: 0 });
    world.playerTags.add(playerEid, true);

    const systems = {
      inputSystem: createInputSystem(keyboard),
      playerInputSystem: createPlayerInputSystem(
        () => speedKnob(),
        () => scene.getScreenPixelBasis()
      ),
      movementSystem: createMovementSystem(),
      eventSystem: createEventSystem(debug)
    };

    return {
      systems,
      step() {
        const t = world.transforms.get(playerEid);
        if (t) {
          player.setPosition(t.x, PLAYER_HEIGHT, t.y);
        }
        grid.setVisible(showGridKnob());
      },
      dispose() {
        player.dispose();
        floor.dispose();
        grid.dispose();
      }
    };
  }
};

export default gridWalker;
