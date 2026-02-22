import { describe, expect, it } from "vitest";
import { queryMaxBackingSize } from "./gl-caps";

function makeFakeGl(values: {
  viewport: [number, number];
  renderbuffer: number;
  texture: number;
}): WebGLRenderingContext {
  const constants = {
    MAX_VIEWPORT_DIMS: 1,
    MAX_RENDERBUFFER_SIZE: 2,
    MAX_TEXTURE_SIZE: 3
  } as const;
  return {
    ...constants,
    getParameter(param: number): unknown {
      if (param === constants.MAX_VIEWPORT_DIMS) return values.viewport;
      if (param === constants.MAX_RENDERBUFFER_SIZE) return values.renderbuffer;
      if (param === constants.MAX_TEXTURE_SIZE) return values.texture;
      return 0;
    }
  } as unknown as WebGLRenderingContext;
}

describe("@common/render gl caps", () => {
  it("uses the minimum of viewport, renderbuffer, and texture caps", () => {
    const gl = makeFakeGl({
      viewport: [8192, 4096],
      renderbuffer: 2048,
      texture: 4096
    });
    expect(queryMaxBackingSize(gl)).toEqual({ width: 2048, height: 2048 });
  });

  it("falls back to conservative default caps when GL returns invalid values", () => {
    const gl = makeFakeGl({
      viewport: [0, 0],
      renderbuffer: 0,
      texture: 0
    });
    expect(queryMaxBackingSize(gl)).toEqual({ width: 8192, height: 8192 });
  });
});
