import * as THREE from "three";
import { describe, it, expect, vi } from "vitest";
import { assignOutlineGroupsByMaterialName } from "./outline-groups";
import type { OutlinePipeline } from "../outline/outline-pipeline";

type TraverseCallback = (mesh: THREE.Mesh) => string | null;

function makePipeline() {
  const assigned = new Map<THREE.Mesh, string>();
  const pipeline = {
    assignOutlineGroupsUnder: vi.fn((root: THREE.Object3D, classify: TraverseCallback) => {
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const key = classify(obj);
          if (key !== null) assigned.set(obj, key);
        }
      });
    })
  } as unknown as OutlinePipeline;
  return { pipeline, assigned };
}

function mkMesh(materialName: string | string[]): THREE.Mesh {
  const names = Array.isArray(materialName) ? materialName : [materialName];
  const mats = names.map((n) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff });
    m.name = n;
    return m;
  });
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    mats.length === 1 ? mats[0] : mats
  );
}

describe("assignOutlineGroupsByMaterialName", () => {
  it("looks up material name via shorthand record form", () => {
    const root = new THREE.Group();
    const a = mkMesh("blockstudio_accent");
    const b = mkMesh("blockstudio_trim");
    const c = mkMesh("plain");
    root.add(a, b, c);

    const { pipeline, assigned } = makePipeline();
    assignOutlineGroupsByMaterialName(root, pipeline, {
      blockstudio_accent: "glass",
      blockstudio_trim: "trim"
    });

    expect(assigned.get(a)).toBe("glass");
    expect(assigned.get(b)).toBe("trim");
    expect(assigned.get(c)).toBe("default");
  });

  it("honours default and byName in the verbose form", () => {
    const root = new THREE.Group();
    const a = mkMesh("blockstudio_accent");
    const b = mkMesh("plain");
    root.add(a, b);

    const { pipeline, assigned } = makePipeline();
    assignOutlineGroupsByMaterialName(root, pipeline, {
      byName: { blockstudio_accent: "glass" },
      default: "wall"
    });

    expect(assigned.get(a)).toBe("glass");
    expect(assigned.get(b)).toBe("wall");
  });

  it("runs predicate before byName; predicate null falls through", () => {
    const root = new THREE.Group();
    const a = mkMesh("blockstudio_accent");
    const b = mkMesh("other");
    root.add(a, b);

    const { pipeline, assigned } = makePipeline();
    assignOutlineGroupsByMaterialName(root, pipeline, {
      byName: { blockstudio_accent: "glass" },
      default: "wall",
      predicate: (mesh) => (mesh === b ? "special" : null)
    });

    // a: predicate returns null → byName hits "glass"
    expect(assigned.get(a)).toBe("glass");
    // b: predicate returns "special" → predicate wins over default
    expect(assigned.get(b)).toBe("special");
  });

  it("iterates material array and takes first hit", () => {
    const root = new THREE.Group();
    const mesh = mkMesh(["plain", "blockstudio_accent", "blockstudio_trim"]);
    root.add(mesh);

    const { pipeline, assigned } = makePipeline();
    assignOutlineGroupsByMaterialName(root, pipeline, {
      blockstudio_accent: "glass",
      blockstudio_trim: "trim"
    });
    // "plain" doesn't match, "blockstudio_accent" wins before "blockstudio_trim".
    expect(assigned.get(mesh)).toBe("glass");
  });

  it("handles materials with no name and unset materials gracefully", () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    // default Mesh has a default material with name ""
    root.add(mesh);

    const { pipeline, assigned } = makePipeline();
    assignOutlineGroupsByMaterialName(root, pipeline, {
      byName: { something: "x" },
      default: "fallback"
    });
    expect(assigned.get(mesh)).toBe("fallback");
  });
});
