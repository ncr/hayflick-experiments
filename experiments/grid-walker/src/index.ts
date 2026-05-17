import { defineGame } from "@common/gameplay";

export default defineGame({
  id: "grid-walker",
  title: "Grid Walker",
  description: "Arrow keys move a box on a flat tile floor.",

  setup({ scene, world, knobs }) {
    const speed = knobs.number("speed", { min: 0, max: 240, default: 80, step: 10 });
    const showGrid = knobs.toggle("showGrid", { default: true });

    scene.spawnFloor({ size: 20, color: 0x1f2329 });
    const grid = scene.spawnGrid({
      size: 20,
      color: 0x6a6558,
      secondaryColor: 0x3a3d44
    });
    const box = scene.spawnBox({
      size: 1,
      color: 0xd97706,
      anchor: "bottom"
    });

    const player = world.createEntity();
    world.transforms.add(player, { x: 0, y: 0 });
    world.controlled.add(player, { speed });
    world.meshes.add(player, box);

    return {
      step() {
        grid.setVisible(showGrid());
      }
    };
  }
});
