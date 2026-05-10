import * as THREE from "three";
import {
  createEventSystem,
  createInputSystem,
  createMovementSystem,
  createPlayerInputSystem,
  type GameModule
} from "@common/gameplay";

const FLOOR_SIZE = 20;
const PLAYER_SIZE = 0.8;
const PLAYER_HEIGHT = PLAYER_SIZE / 2;

const gridWalker: GameModule<THREE.Object3D> = {
  id: "grid-walker",
  title: "Grid Walker",
  description: "Tiny ECS demo: arrow keys move a player on a flat tile floor.",

  create({ rootNode, world, keyboard, debug, knobs }) {
    const speedKnob = knobs.number("player.speed", {
      min: 0.5,
      max: 12,
      default: 4,
      step: 0.5
    });
    const showGridKnob = knobs.toggle("debug.showGrid", { default: true });

    const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, 0x6a6558, 0x3a3d44);
    grid.position.y = 0.001;
    rootNode.add(grid);

    const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x1f2329,
      roughness: 0.95,
      metalness: 0
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    rootNode.add(floor);

    const playerGeo = new THREE.BoxGeometry(PLAYER_SIZE, PLAYER_SIZE, PLAYER_SIZE);
    const playerMat = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      roughness: 0.4,
      metalness: 0.05
    });
    const playerMesh = new THREE.Mesh(playerGeo, playerMat);
    playerMesh.position.set(0, PLAYER_HEIGHT, 0);
    rootNode.add(playerMesh);

    const playerEid = world.createEntity();
    world.transforms.add(playerEid, { x: 0, y: 0 });
    world.velocities.add(playerEid, { vx: 0, vy: 0 });
    world.playerTags.add(playerEid, true);

    const systems = {
      inputSystem: createInputSystem(keyboard),
      playerInputSystem: createPlayerInputSystem(() => speedKnob()),
      movementSystem: createMovementSystem(),
      eventSystem: createEventSystem(debug)
    };

    return {
      systems,
      step() {
        const t = world.transforms.get(playerEid);
        if (t) {
          playerMesh.position.set(t.x, PLAYER_HEIGHT, t.y);
        }
        grid.visible = showGridKnob();
      },
      dispose() {
        rootNode.remove(grid);
        rootNode.remove(floor);
        rootNode.remove(playerMesh);
        playerGeo.dispose();
        playerMat.dispose();
        floorGeo.dispose();
        floorMat.dispose();
        if (Array.isArray(grid.material)) {
          for (const m of grid.material) m.dispose();
        } else {
          (grid.material as THREE.Material).dispose();
        }
        grid.geometry.dispose();
      }
    };
  }
};

export default gridWalker;
