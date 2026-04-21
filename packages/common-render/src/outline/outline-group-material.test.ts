import { describe, expect, it } from "vitest";
import {
  OUTLINE_GROUP_ID_EPS,
  OutlineGroupMaterial,
  encodeOutlineGroupColor
} from "./outline-group-material";

describe("encodeOutlineGroupColor", () => {
  it("returns a non-zero colour for id=0 so it survives RGBA8 quantization", () => {
    const c = encodeOutlineGroupColor(0);
    expect(c.r).toBeGreaterThanOrEqual(OUTLINE_GROUP_ID_EPS);
    expect(c.g).toBeGreaterThanOrEqual(OUTLINE_GROUP_ID_EPS);
    expect(c.b).toBeGreaterThanOrEqual(OUTLINE_GROUP_ID_EPS);
  });

  it("gives distinct colours for adjacent ids", () => {
    const a = encodeOutlineGroupColor(1);
    const b = encodeOutlineGroupColor(2);
    const distance = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(distance).toBeGreaterThan(0.05);
  });

  it("is deterministic: same id → same colour", () => {
    const a = encodeOutlineGroupColor(42);
    const b = encodeOutlineGroupColor(42);
    expect(a.r).toBeCloseTo(b.r);
    expect(a.g).toBeCloseTo(b.g);
    expect(a.b).toBeCloseTo(b.b);
  });

  it("re-uses an `out` color when provided", () => {
    const out = encodeOutlineGroupColor(0);
    const returned = encodeOutlineGroupColor(99, out);
    expect(returned).toBe(out);
  });
});

describe("OutlineGroupMaterial", () => {
  it("stores the requested groupId and carries a matching uIdColor uniform", () => {
    const m = new OutlineGroupMaterial(7);
    expect(m.groupId).toBe(7);
    const uColor = m.uniforms.uIdColor.value;
    expect(uColor.r).toBeCloseTo(m.color.r);
    expect(uColor.g).toBeCloseTo(m.color.g);
    expect(uColor.b).toBeCloseTo(m.color.b);
  });

  it("renders on both sides (DoubleSide) so back faces don't drop out of the id pass", () => {
    const m = new OutlineGroupMaterial(1);
    expect(m.side).toBe(2); // THREE.DoubleSide
  });
});
