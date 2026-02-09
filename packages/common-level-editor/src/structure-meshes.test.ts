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
    const join = kit.createJoinPost(1 | 2 | 4);
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

  it("creates specialized join caps for corner/tee/cross masks", () => {
    const kit = createEditorStructureMeshKit();
    const corner = kit.createJoinPost(1 | 2);
    const tee = kit.createJoinPost(1 | 2 | 8);
    const cross = kit.createJoinPost(1 | 2 | 4 | 8);
    const straight = kit.createJoinPost(1 | 4);

    expect(corner.children.length).toBe(1);
    expect(tee.children.length).toBe(1);
    expect(cross.children.length).toBe(1);
    expect(straight.children.length).toBe(0);

    kit.dispose();
  });

  it("supports endpoint trimming on segments used near junction caps", () => {
    const kit = createEditorStructureMeshKit();
    const trimmed = kit.createWallSegment({ trimStart: true, trimEnd: true });
    const oneSided = kit.createWallSegment({ trimStart: true });

    expect(trimmed.scale.x).toBeLessThan(1);
    expect(trimmed.position.x).toBe(0);
    expect(oneSided.position.x).toBeGreaterThan(0);

    kit.dispose();
  });

  it("orients corner and tee masks to the expected world directions", () => {
    const kit = createEditorStructureMeshKit();
    const cornerNE = kit.createJoinPost(1 | 2);
    const cornerES = kit.createJoinPost(2 | 4);
    const cornerWN = kit.createJoinPost(8 | 1);
    const teeNES = kit.createJoinPost(1 | 2 | 4);
    const teeNSW = kit.createJoinPost(1 | 4 | 8);

    const cornerNEYaw = (cornerNE.children[0] as THREE.Mesh | undefined)?.rotation.y ?? NaN;
    const cornerESYaw = (cornerES.children[0] as THREE.Mesh | undefined)?.rotation.y ?? NaN;
    const cornerWNYaw = (cornerWN.children[0] as THREE.Mesh | undefined)?.rotation.y ?? NaN;
    const teeNESYaw = (teeNES.children[0] as THREE.Mesh | undefined)?.rotation.y ?? NaN;
    const teeNSWYaw = (teeNSW.children[0] as THREE.Mesh | undefined)?.rotation.y ?? NaN;

    expect(cornerNEYaw).toBeCloseTo(0, 6);
    expect(cornerESYaw).toBeCloseTo(-Math.PI * 0.5, 6);
    expect(cornerWNYaw).toBeCloseTo(Math.PI * 0.5, 6);
    expect(teeNESYaw).toBeCloseTo(-Math.PI * 0.5, 6);
    expect(teeNSWYaw).toBeCloseTo(Math.PI * 0.5, 6);

    kit.dispose();
  });

  it("keeps join caps flush with wall height and wall material", () => {
    const kit = createEditorStructureMeshKit();
    const wall = kit.createWallSegment();
    const join = kit.createJoinPost(1 | 2);

    const wallCore = wall.children[0] as THREE.Mesh | undefined;
    const joinCore = join.children[0] as THREE.Mesh | undefined;
    expect(wallCore).toBeTruthy();
    expect(joinCore).toBeTruthy();

    const wallMaterial = wallCore?.material as THREE.Material | undefined;
    const joinMaterial = joinCore?.material as THREE.Material | undefined;
    expect(joinMaterial).toBe(wallMaterial);

    const wallBounds = new THREE.Box3().setFromObject(wall);
    const joinBounds = new THREE.Box3().setFromObject(join);
    expect(joinBounds.max.y).toBeCloseTo(wallBounds.max.y, 6);

    kit.dispose();
  });
});
