import { describe, expect, it } from "vitest";
import { LinearDepthMaterial } from "./linear-depth-material";

describe("LinearDepthMaterial", () => {
  it("stores the initial near/far on uniforms", () => {
    const m = new LinearDepthMaterial(0.1, 200);
    expect(m.uniforms.uNear.value).toBe(0.1);
    expect(m.uniforms.uFar.value).toBe(200);
  });

  it("setRange updates uniforms in place", () => {
    const m = new LinearDepthMaterial(0.1, 200);
    m.setRange(1.0, 50);
    expect(m.uniforms.uNear.value).toBe(1.0);
    expect(m.uniforms.uFar.value).toBe(50);
  });

  it("uses DoubleSide so back faces write depth too", () => {
    const m = new LinearDepthMaterial(0.1, 200);
    expect(m.side).toBe(2); // THREE.DoubleSide
  });
});
