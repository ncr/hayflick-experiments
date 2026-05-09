import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  GREYBOX_BASE_UNIT_CM,
  GREYBOX_CATALOG,
  GREYBOX_MIN_DETAIL_CM,
  assertGreyboxCatalogValid,
  createGreyboxMeshTemplate,
  disposeGreyboxMeshTemplate,
  findGreyboxDefinition,
  greyboxCmToWorld
} from "./greybox";

describe("greybox catalog", () => {
  it("keeps a flat, valid catalog with grid-aligned dimensions", () => {
    expect(() => assertGreyboxCatalogValid()).not.toThrow();

    const ids = GREYBOX_CATALOG.definitions.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GREYBOX_CATALOG.units.baseUnitCm).toBe(128);
    expect(GREYBOX_CATALOG.units.minDetailCm).toBe(GREYBOX_MIN_DETAIL_CM);

    for (const definition of GREYBOX_CATALOG.definitions) {
      expect(definition.dimensionsCm[0] % GREYBOX_BASE_UNIT_CM).toBe(0);
      expect(definition.boxes.length).toBeGreaterThan(0);
      for (const box of definition.boxes) {
        expect(Math.min(...box.sizeCm)).toBeGreaterThanOrEqual(GREYBOX_MIN_DETAIL_CM);
      }
    }
  });

  it("represents same-geometry surfaces as separate semantic blocks", () => {
    const grass = findGreyboxDefinition("terrain_grass");
    const asphalt = findGreyboxDefinition("terrain_asphalt");

    expect(grass?.boxes.map((box) => box.sizeCm)).toEqual(asphalt?.boxes.map((box) => box.sizeCm));
    expect(grass?.semantic.terrain).toBe("grass");
    expect(asphalt?.semantic.terrain).toBe("road");
  });

  it("represents doors as one greybox definition with placement state", () => {
    expect(findGreyboxDefinition("door_open")).toBeUndefined();
    expect(findGreyboxDefinition("door_closed")).toBeUndefined();

    const door = findGreyboxDefinition("door_box");
    expect(door?.semantic.kind).toBe("door");
    expect(door?.states?.default).toBe("closed");
    expect(door?.states?.values.open?.semantic?.blocksMovement).toBe(false);
    expect(door?.states?.values.closed?.semantic?.blocksMovement).toBe(true);

    const open = createGreyboxMeshTemplate(door!, { state: "open" });
    const closed = createGreyboxMeshTemplate(door!, { state: "closed" });
    expect(open.userData.greybox.state).toBe("open");
    expect(closed.userData.greybox.state).toBe("closed");
    expect(open.userData.greybox.semantic.blocksMovement).toBe(false);
    expect(closed.userData.greybox.semantic.blocksMovement).toBe(true);

    disposeGreyboxMeshTemplate(open);
    disposeGreyboxMeshTemplate(closed);
  });

  it("creates procedural meshes at the 1 base cell = 128 cm world scale", () => {
    const wall = findGreyboxDefinition("wall_solid");
    expect(wall).toBeTruthy();

    const template = createGreyboxMeshTemplate(wall!);
    const bounds = new THREE.Box3().setFromObject(template);

    expect(bounds.max.x - bounds.min.x).toBeCloseTo(greyboxCmToWorld(128), 6);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(greyboxCmToWorld(280), 6);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(greyboxCmToWorld(32), 6);
    expect(template.userData.greybox.definitionId).toBe("wall_solid");

    disposeGreyboxMeshTemplate(template);
  });

  it("anchors corner arms on the grid-line centerlines", () => {
    const corner = findGreyboxDefinition("corner_solid");
    expect(corner).toBeTruthy();

    const template = createGreyboxMeshTemplate(corner!);
    const bounds = new THREE.Box3().setFromObject(template);

    expect(bounds.min.x).toBeCloseTo(greyboxCmToWorld(-16), 6);
    expect(bounds.min.z).toBeCloseTo(greyboxCmToWorld(-16), 6);
    expect(bounds.max.x).toBeCloseTo(greyboxCmToWorld(128), 6);
    expect(bounds.max.z).toBeCloseTo(greyboxCmToWorld(128), 6);

    disposeGreyboxMeshTemplate(template);
  });

  it("miters the corner arms so one box owns the shared corner cap", () => {
    const corner = findGreyboxDefinition("corner_solid");
    expect(corner).toBeTruthy();

    const xArm = corner?.boxes.find((box) => box.id === "x-arm");
    const zArm = corner?.boxes.find((box) => box.id === "z-arm");

    expect(xArm?.centerCm).toEqual([56, 140, 0]);
    expect(xArm?.sizeCm).toEqual([144, 280, 32]);
    expect(zArm?.centerCm).toEqual([0, 140, 72]);
    expect(zArm?.sizeCm).toEqual([32, 280, 112]);

    const template = createGreyboxMeshTemplate(corner!);
    const xMesh = template.children.find((child) => child.name === "corner_solid:x-arm");
    const zMesh = template.children.find((child) => child.name === "corner_solid:z-arm");
    expect(xMesh).toBeTruthy();
    expect(zMesh).toBeTruthy();

    const xBounds = new THREE.Box3().setFromObject(xMesh!);
    const zBounds = new THREE.Box3().setFromObject(zMesh!);
    expect(xBounds.min.x).toBeCloseTo(greyboxCmToWorld(-16), 6);
    expect(xBounds.max.x).toBeCloseTo(greyboxCmToWorld(128), 6);
    expect(zBounds.min.z).toBeCloseTo(greyboxCmToWorld(16), 6);
    expect(zBounds.max.z).toBeCloseTo(greyboxCmToWorld(128), 6);

    disposeGreyboxMeshTemplate(template);
  });
});
