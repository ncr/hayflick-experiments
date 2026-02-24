import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readAppCss(): string {
  return readFileSync(new URL("./app.css", import.meta.url), "utf8");
}

describe("hub app shell layering CSS", () => {
  it("contains fixed-position experiment overlays inside the stage host", () => {
    const css = readAppCss();

    expect(css).toContain(".stage-host");
    expect(css).toContain("contain: paint;");
    expect(css).toContain("isolation: isolate;");
  });

  it("keeps the page header in a higher local layer than stage content", () => {
    const css = readAppCss();

    expect(css).toContain(".main-header");
    expect(css).toContain("position: relative;");
    expect(css).toContain("z-index: 2;");
  });
});
