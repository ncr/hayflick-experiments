import { test } from "vitest";
import assert from "node:assert/strict";

import { createKitDefinition, createModularKitDefinition } from "../src/shared/kit.js";
import { buildWallKitCatalogScene, buildGroundKitCatalogScene, CATALOG_ROOT_NAME } from "../src/shared/scene-plan.js";

function createWallKit() {
  return createKitDefinition({
    spec: {
      name: "scene_plan_wall_kit",
      baseUnit: 128,
      authoringUnitsPerBaseUnit: 128,
      wallSpan: 128,
      wallHeight: 280,
      wallThickness: 32,
      floorThickness: 6,
      door: {
        width: 90,
        height: 220,
        frameThickness: 16,
        frameProtrusion: 3,
        thickness: 5,
        hingeSide: "left"
      },
      windowFamilies: [
        {
          name: "vertical_black_panel",
          leftWidth: 16,
          middleWidth: 32,
          rightWidth: 16,
          sillHeight: 0,
          openingHeight: 280,
          glassThickness: 4,
          variants: [{ name: "fixed", articulation: { type: "fixed" } }]
        }
      ]
    },
    styleProfile: { id: "style_1" }
  });
}

function getChild(group, name) {
  return (group.children || []).find((child) => child && child.name === name) || null;
}

function relativeBounds(node, origin) {
  return {
    from: node.from.map((value, index) => value - origin[index]),
    to: node.to.map((value, index) => value - origin[index])
  };
}

function relativeOrigin(node, origin) {
  return node.origin.map((value, index) => value - origin[index]);
}

test("buildWallKitCatalogScene keeps the wall pivot at the logical edge midpoint", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;
  const wallGroup = getChild(root, "wall");
  const wallBody = getChild(wallGroup, "wall_body");
  const wallPart = build.manifest.parts.find((part) => part.name === "wall");

  assert.equal(root.name, CATALOG_ROOT_NAME);
  assert.deepEqual(wallGroup.origin, [224, 0, 0]);
  assert.deepEqual(wallPart.sceneAnchor, [224, 0, 0]);
  assert.deepEqual(wallPart.anchorLocal, [0, 0, 0]);
  assert.equal(wallBody.type, "cube");
  assert.deepEqual(relativeBounds(wallBody, wallGroup.origin), {
    from: [-64, 0, -16],
    to: [64, 280, 16]
  });
});

test("buildWallKitCatalogScene keeps the floor pivot under the slab and grows upward from zero", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;
  const floorGroup = getChild(root, "floor_tile");
  const floorBody = getChild(floorGroup, "floor_tile_body");
  const floorPart = build.manifest.parts.find((part) => part.name === "floor_tile");

  assert.deepEqual(floorGroup.origin, [0, 0, 0]);
  assert.deepEqual(floorPart.sceneAnchor, [0, 0, 0]);
  assert.deepEqual(floorPart.anchorLocal, [0, 0, 0]);
  assert.equal(floorBody.type, "cube");
  assert.deepEqual(relativeOrigin(floorBody, floorGroup.origin), [0, 0, 0]);
  assert.deepEqual(relativeBounds(floorBody, floorGroup.origin), {
    from: [-64, 0, -64],
    to: [64, 6, 64]
  });
});

test("buildWallKitCatalogScene emits contiguous one-cell window modules", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;
  const leftGroup = getChild(root, "window_left");
  const middleGroup = getChild(root, "window_middle");
  const rightGroup = getChild(root, "window_right");

  const leftWall = getChild(leftGroup, "window_left_left_wall");
  const leftGlass = getChild(leftGroup, "window_glass");
  assert.equal(leftWall.type, "cube");
  assert.deepEqual(relativeOrigin(leftWall, leftGroup.origin), [-56, 0, 0]);
  assert.deepEqual(relativeOrigin(leftGlass, leftGroup.origin), [8, 0, 0]);
  assert.deepEqual(relativeBounds(leftWall, leftGroup.origin), {
    from: [-64, 0, -16],
    to: [-48, 280, 16]
  });
  assert.deepEqual(relativeBounds(leftGlass, leftGroup.origin), {
    from: [-48, 0, -2],
    to: [64, 280, 2]
  });

  const middleGlass = getChild(middleGroup, "window_glass");
  assert.deepEqual(relativeOrigin(middleGlass, middleGroup.origin), [0, 0, 0]);
  assert.deepEqual(relativeBounds(middleGlass, middleGroup.origin), {
    from: [-64, 0, -2],
    to: [64, 280, 2]
  });

  const rightGlass = getChild(rightGroup, "window_glass");
  const rightWall = getChild(rightGroup, "window_right_right_wall");
  assert.equal(rightWall.type, "cube");
  assert.deepEqual(relativeOrigin(rightGlass, rightGroup.origin), [-8, 0, 0]);
  assert.deepEqual(relativeOrigin(rightWall, rightGroup.origin), [56, 0, 0]);
  assert.deepEqual(relativeBounds(rightGlass, rightGroup.origin), {
    from: [-64, 0, -2],
    to: [48, 280, 2]
  });
  assert.deepEqual(relativeBounds(rightWall, rightGroup.origin), {
    from: [48, 0, -16],
    to: [64, 280, 16]
  });
});

test("buildWallKitCatalogScene keeps door frame pieces centered on themselves and the leaf on the hinge", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;
  const doorGroup = getChild(root, "door");
  const left = getChild(doorGroup, "door_left");
  const right = getChild(doorGroup, "door_right");
  const header = getChild(doorGroup, "door_header");
  const leafGroup = getChild(doorGroup, "door_leaf");
  const leafBody = getChild(leafGroup, "door_leaf_body");
  const doorPart = build.manifest.parts.find((part) => part.name === "door");

  assert.deepEqual(doorGroup.origin, [448, 0, 0]);
  assert.deepEqual(doorPart.sceneAnchor, [448, 0, 0]);
  assert.deepEqual(doorPart.articulationPivot, [-45, 0, -10.5]);

  assert.equal(left.type, "cube");
  assert.deepEqual(relativeOrigin(left, doorGroup.origin), [-54.5, 0, 0]);
  assert.deepEqual(relativeBounds(left, doorGroup.origin), {
    from: [-64, 0, -16],
    to: [-45, 280, 16]
  });

  assert.equal(right.type, "cube");
  assert.deepEqual(relativeOrigin(right, doorGroup.origin), [54.5, 0, 0]);
  assert.deepEqual(relativeBounds(right, doorGroup.origin), {
    from: [45, 0, -16],
    to: [64, 280, 16]
  });

  assert.deepEqual(relativeOrigin(header, doorGroup.origin), [0, 220, 0]);
  assert.deepEqual(relativeBounds(header, doorGroup.origin), {
    from: [-45, 220, -16],
    to: [45, 280, 16]
  });

  assert.deepEqual(relativeOrigin(leafGroup, doorGroup.origin), [-45, 0, -10.5]);
  assert.deepEqual(relativeOrigin(leafBody, doorGroup.origin), [-45, 0, -10.5]);
  assert.deepEqual(relativeBounds(leafBody, doorGroup.origin), {
    from: [-45, 0, -13],
    to: [45, 220, -8]
  });
});

test("buildWallKitCatalogScene emits a corner prism that fits inside exactly one base cell", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;
  const cornerGroup = getChild(root, "corner");
  const cornerBody = getChild(cornerGroup, "corner_body");
  const cornerPart = build.manifest.parts.find((part) => part.name === "corner");
  const { baseUnit, wallThickness } = kit.spec;

  const relativeContour = cornerBody.contour.map(([x, z]) => [x - cornerGroup.origin[0], z - cornerGroup.origin[2]]);
  const xs = relativeContour.map((point) => point[0]);
  const zs = relativeContour.map((point) => point[1]);

  assert.equal(cornerBody.type, "polygon_prism");
  assert.deepEqual(cornerPart.sceneAnchor, cornerGroup.origin);
  assert.deepEqual(cornerPart.anchorLocal, [0, 0, 0]);
  assert.deepEqual(relativeOrigin(cornerBody, cornerGroup.origin), [0, 0, 0]);

  // The L-shape must fit inside exactly one base cell (no overhang into
  // neighbouring cells). The outside vertex sits at (0, 0) and the two legs
  // run inward to (baseUnit, 0) and (0, baseUnit).
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), baseUnit);
  assert.equal(Math.min(...zs), 0);
  assert.equal(Math.max(...zs), baseUnit);
  assert.equal(Math.max(...xs) - Math.min(...xs), baseUnit);
  assert.equal(Math.max(...zs) - Math.min(...zs), baseUnit);
  // Corner vertex at the origin of the cell.
  assert.equal(relativeContour.some(([x, z]) => x === 0 && z === 0), true);
  // No vertex should extend past the cell boundary.
  assert.equal(relativeContour.every(([x, z]) => x >= 0 && z >= 0), true);
  // Inner elbow at (thickness, thickness).
  assert.equal(
    relativeContour.some(([x, z]) => x === wallThickness && z === wallThickness),
    true
  );
});

test("manifest sceneAnchors match group origins and anchorLocal is always [0,0,0]", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;

  for (const part of build.manifest.parts) {
    const group = getChild(root, part.name);
    assert.ok(group, `group "${part.name}" should exist in scene plan`);
    assert.deepEqual(part.sceneAnchor, group.origin, `${part.name} sceneAnchor should match group origin`);
    assert.deepEqual(part.anchorLocal, [0, 0, 0], `${part.name} anchorLocal should be [0,0,0]`);
  }
});

test("walls and floors are emitted as plain butt-jointed cubes with no chamfer fields", () => {
  const kit = createWallKit();
  const build = buildWallKitCatalogScene({ kit });
  const root = build.scenePlan.root;

  const wallBody = getChild(getChild(root, "wall"), "wall_body");
  assert.equal(wallBody.type, "cube");
  assert.equal(wallBody.chamfer, undefined);
  assert.equal(wallBody.chamferMode, undefined);
  assert.equal(wallBody.chamferCorners, undefined);

  const floorBody = getChild(getChild(root, "floor_tile"), "floor_tile_body");
  assert.equal(floorBody.type, "cube");
  assert.equal(floorBody.chamfer, undefined);

  const doorGroup = getChild(root, "door");
  const doorLeft = getChild(doorGroup, "door_left");
  const doorRight = getChild(doorGroup, "door_right");
  assert.equal(doorLeft.type, "cube");
  assert.equal(doorLeft.chamferCorners, undefined);
  assert.equal(doorRight.type, "cube");
  assert.equal(doorRight.chamferCorners, undefined);

  const windowMiddle = getChild(root, "window_middle");
  const middleGlass = getChild(windowMiddle, "window_glass");
  assert.equal(middleGlass.type, "cube");
});

test("buildGroundKitCatalogScene emits one floor tile group per tile in spec", () => {
  const kit = createModularKitDefinition({
    kind: "ground",
    spec: {
      name: "ground_tiles",
      tiles: [{ name: "grass" }, { name: "concrete_walk" }, { name: "asphalt" }]
    }
  });
  const build = buildGroundKitCatalogScene({ kit });
  const root = build.scenePlan.root;

  assert.equal(root.name, CATALOG_ROOT_NAME);
  assert.equal(root.children.length, 3);
  assert.deepEqual(root.children.map((c) => c.name).sort(), ["asphalt", "concrete_walk", "grass"]);

  assert.equal(build.manifest.parts.length, 3);
  for (const part of build.manifest.parts) {
    assert.equal(part.kind, "floor_tile");
    assert.deepEqual(part.anchorLocal, [0, 0, 0]);
    const group = getChild(root, part.name);
    assert.ok(group, `group "${part.name}" should exist`);
    assert.deepEqual(part.sceneAnchor, group.origin);
    const body = group.children[0];
    assert.equal(body.type, "cube");
    assert.equal(body.textureRole, part.name);
  }
});
