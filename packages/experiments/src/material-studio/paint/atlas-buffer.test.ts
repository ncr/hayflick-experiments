import { describe, it, expect } from "vitest";
import { cloneMask, cloneRgba, drawLine, hexToRgb, setPixel } from "./atlas-buffer";

function makeBuffers(w: number, h: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);
  return { rgba, mask };
}

describe("setPixel", () => {
  it("writes 4 RGBA bytes + mask byte at the pixel index", () => {
    const { rgba, mask } = makeBuffers(4, 4);
    setPixel(rgba, mask, 4, 1, 2, 200, 100, 50, 1);
    const i = (2 * 4 + 1) * 4;
    expect(rgba[i]).toBe(200);
    expect(rgba[i + 1]).toBe(100);
    expect(rgba[i + 2]).toBe(50);
    expect(rgba[i + 3]).toBe(255);
    expect(mask[2 * 4 + 1]).toBe(1);
  });
});

describe("drawLine", () => {
  it("paints the four corners of a 4x4 diagonal correctly", () => {
    const { rgba, mask } = makeBuffers(4, 4);
    drawLine(rgba, mask, 4, 4, 0, 0, 3, 3, 255, 0, 0, 1);
    expect(rgba[(0 * 4 + 0) * 4]).toBe(255);
    expect(rgba[(1 * 4 + 1) * 4]).toBe(255);
    expect(rgba[(2 * 4 + 2) * 4]).toBe(255);
    expect(rgba[(3 * 4 + 3) * 4]).toBe(255);
    expect(mask[0]).toBe(1);
    expect(mask[3 * 4 + 3]).toBe(1);
  });

  it("paints a horizontal line across all expected pixels", () => {
    const { rgba, mask } = makeBuffers(8, 1);
    drawLine(rgba, mask, 8, 1, 0, 0, 7, 0, 0, 255, 0, 1);
    for (let x = 0; x < 8; x++) {
      expect(rgba[x * 4 + 1]).toBe(255);
      expect(mask[x]).toBe(1);
    }
  });

  it("silently clips pixels that fall outside the buffer", () => {
    const { rgba, mask } = makeBuffers(4, 4);
    drawLine(rgba, mask, 4, 4, -2, -2, 3, 3, 255, 0, 0, 1);
    // Pixel at (0,0) should be painted; out-of-bounds pixels skipped.
    expect(rgba[0]).toBe(255);
    expect(rgba.length).toBe(64);
  });

  it("eraser mode (maskValue=0) sets mask to 0 and paints the color", () => {
    const { rgba, mask } = makeBuffers(2, 2);
    // Pre-paint
    setPixel(rgba, mask, 2, 0, 0, 100, 200, 50, 1);
    expect(mask[0]).toBe(1);
    drawLine(rgba, mask, 2, 2, 0, 0, 0, 0, 255, 255, 255, 0);
    expect(rgba[0]).toBe(255);
    expect(mask[0]).toBe(0);
  });
});

describe("cloneRgba / cloneMask", () => {
  it("returns deep copies that don't share the source buffer", () => {
    const src = new Uint8ClampedArray([1, 2, 3, 4]);
    const copy = cloneRgba(src);
    expect(copy).not.toBe(src);
    expect(Array.from(copy)).toEqual([1, 2, 3, 4]);
    copy[0] = 99;
    expect(src[0]).toBe(1);
  });

  it("clones masks the same way", () => {
    const src = new Uint8Array([0, 1, 0, 1]);
    const copy = cloneMask(src);
    expect(copy).not.toBe(src);
    expect(Array.from(copy)).toEqual([0, 1, 0, 1]);
  });
});

describe("hexToRgb", () => {
  it("parses #rrggbb and rrggbb forms", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("#1a1a1a")).toEqual({ r: 26, g: 26, b: 26 });
  });
});
