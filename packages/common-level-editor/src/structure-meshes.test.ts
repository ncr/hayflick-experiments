import { describe, expect, it } from "vitest";
import { createEditorStructureMeshKit, setDoorVisualOpen } from "./structure-meshes";

describe("structure meshes", () => {
  it("creates reusable structure meshes and toggles door state", () => {
    const kit = createEditorStructureMeshKit();

    const wall = kit.createWallSegment();
    const windowSegment = kit.createWindowSegment();
    const door = kit.createDoorVisual();
    const doorClosed = kit.createDoorSegment("closed");
    const doorOpen = kit.createDoorSegment("open");
    const join = kit.createJoinPost(3);
    const block = kit.createWallBlock();

    expect(wall.children.length).toBeGreaterThan(0);
    expect(windowSegment.children.length).toBeGreaterThan(0);
    expect(door.root.children.length).toBeGreaterThan(0);
    expect(doorClosed.children.length).toBeGreaterThan(0);
    expect(doorOpen.children.length).toBeGreaterThan(0);
    expect(join.children.length).toBeGreaterThan(0);
    expect(block.children.length).toBeGreaterThanOrEqual(8);

    setDoorVisualOpen(door, false);
    expect(door.leafPivot.rotation.y).toBe(0);
    setDoorVisualOpen(door, true);
    expect(door.leafPivot.rotation.y).toBe(-Math.PI * 0.5);

    kit.dispose();
  });
});
