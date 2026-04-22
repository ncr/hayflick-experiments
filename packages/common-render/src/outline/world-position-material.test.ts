import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { WorldPositionMaterial } from "./world-position-material";

describe("WorldPositionMaterial", () => {
  it("renders double-sided so back-faces still contribute to the world-pos G-buffer", () => {
    const m = new WorldPositionMaterial();
    expect(m.side).toBe(THREE.DoubleSide);
  });

  it("carries no user-facing uniforms — the shader just writes vWorldPos", () => {
    const m = new WorldPositionMaterial();
    expect(Object.keys(m.uniforms)).toHaveLength(0);
  });
});
