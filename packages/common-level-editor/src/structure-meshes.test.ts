import * as THREE from "three";
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

  it("injects stripe shader logic into pbr materials using opaque fragment hook", () => {
    const kit = createEditorStructureMeshKit();
    const wall = kit.createWallSegment();
    const wallCore = wall.children[0] as THREE.Mesh;
    const material = wallCore.material as THREE.MeshStandardMaterial;

    const shader = {
      uniforms: {},
      vertexShader: `
        #include <common>
        #include <begin_vertex>
      `,
      fragmentShader: `
        #include <common>
        #include <opaque_fragment>
      `
    };

    material.onBeforeCompile(
      shader as never,
      {} as never
    );

    expect(shader.vertexShader).toContain("vStripeWorldY");
    expect(shader.fragmentShader).toContain("uStripeColor");
    expect(shader.fragmentShader).toContain("outgoingLight = mix(outgoingLight, uStripeColor, stripeMask);");
    expect(shader.fragmentShader).toContain("#include <opaque_fragment>");

    kit.dispose();
  });

  it("supports segment trimming at junction ends to avoid overlap", () => {
    const kit = createEditorStructureMeshKit();
    const trimmed = kit.createWallSegment({ trimStart: true, trimEnd: true });
    const oneSided = kit.createWallSegment({ trimStart: true, trimEnd: false });

    expect(trimmed.scale.x).toBeLessThan(1);
    expect(trimmed.position.x).toBe(0);
    expect(oneSided.position.x).toBeGreaterThan(0);

    kit.dispose();
  });
});
