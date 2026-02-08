import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromotedEditorControls } from "./editor-controls";
import { createEditorHud } from "./editor-hud";

type Listener = (event: { preventDefault: () => void }) => void;

class FakeElement {
  readonly tagName: string;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = "";
  type = "";
  value = "";
  private readonly listeners = new Map<string, Listener[]>();
  focusCalls: unknown[] = [];

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
    }
  }

  addEventListener(type: string, handler: Listener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  trigger(type: string): void {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler({
        preventDefault() {
          // no-op
        }
      });
    }
  }

  focus(options?: unknown): void {
    this.focusCalls.push(options);
  }
}

function findByText(root: FakeElement, label: string): FakeElement | null {
  if (root.textContent === label) {
    return root;
  }

  for (const child of root.children) {
    const found = findByText(child, label);
    if (found) {
      return found;
    }
  }

  return null;
}

describe("createPromotedEditorControls", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElement(tag: string) {
        return new FakeElement(tag);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates promoted controls and routes all editor actions", () => {
    const mount = new FakeElement("div");
    const focusTarget = new FakeElement("canvas");
    const hud = createEditorHud({
      mount: mount as unknown as HTMLElement,
      title: "Editor",
      description: "Controls",
      hints: "",
      focusTarget: focusTarget as unknown as HTMLElement
    });

    const calls: Record<string, unknown[]> = {
      tool: [],
      brush: [],
      rect: [],
      defaultGround: [],
      seed: [],
      rotate: [],
      reset: [],
      clearStructures: [],
      clearGround: [],
      bake: [],
      exit: []
    };

    const controls = createPromotedEditorControls({
      hud,
      initialSeed: 7,
      onTool(mode): void {
        calls.tool.push(mode);
      },
      onBrush(brush): void {
        calls.brush.push(brush);
      },
      onRectTool(mode): void {
        calls.rect.push(mode);
      },
      onDefaultGround(base): void {
        calls.defaultGround.push(base);
      },
      onSeed(seed): void {
        calls.seed.push(seed);
      },
      onRotate(delta): void {
        calls.rotate.push(delta);
      },
      onResetView(): void {
        calls.reset.push(true);
      },
      onClearStructures(): void {
        calls.clearStructures.push(true);
      },
      onClearGround(): void {
        calls.clearGround.push(true);
      },
      onBake(): void {
        calls.bake.push(true);
      },
      onExit(): void {
        calls.exit.push(true);
      }
    });

    expect(controls.toolButtons.size).toBe(2);
    expect(controls.brushButtons.size).toBe(8);
    expect(controls.rectToolButtons.size).toBe(2);
    expect(controls.defaultGroundButtons.size).toBe(2);
    expect(hud.hints.textContent).toContain("EXIT (F5)");

    const click = (label: string): void => {
      const element = findByText(hud.root as unknown as FakeElement, label);
      expect(element).not.toBeNull();
      (element as FakeElement).trigger("click");
    };

    click("EXIT (F5)");
    click("Draw (D)");
    click("Erase (X)");
    click("Wall (1)");
    click("Window (2)");
    click("Door Closed (3)");
    click("Door Open (6)");
    click("Floor (4)");
    click("Grass (5)");
    click("Road (7)");
    click("Sidewalk (8)");
    click("Rect Off");
    click("Grass Fill (G)");
    click("Footprint (9)");
    click("Default Floor");
    click("Default Grass");
    click("Rotate -90 (Q)");
    click("Rotate +90 (E)");
    click("Reset View");
    click("Clear Walls (C)");
    click("Clear Ground (V)");
    click("Bake ECS JSON (B)");

    const seedInput = controls.seedInput as unknown as FakeElement;
    expect(seedInput.value).toBe("7");
    seedInput.value = "42";
    seedInput.trigger("change");
    seedInput.value = "oops";
    seedInput.trigger("change");

    expect(calls.exit).toHaveLength(1);
    expect(calls.tool).toEqual(["draw", "erase"]);
    expect(calls.brush).toEqual([
      "wall",
      "window",
      "door-closed",
      "door-open",
      "floor",
      "grass",
      "road",
      "sidewalk"
    ]);
    expect(calls.rect).toEqual(["none", "grass-fill", "building-footprint"]);
    expect(calls.defaultGround).toEqual(["floor", "grass"]);
    expect(calls.seed).toEqual([42, 1337]);
    expect(calls.rotate).toEqual([-1, 1]);
    expect(calls.reset).toHaveLength(1);
    expect(calls.clearStructures).toHaveLength(1);
    expect(calls.clearGround).toHaveLength(1);
    expect(calls.bake).toHaveLength(1);
    expect(focusTarget.focusCalls.length).toBeGreaterThan(0);
  });

  it("handles missing optional onExit callback", () => {
    const mount = new FakeElement("div");
    const hud = createEditorHud({
      mount: mount as unknown as HTMLElement,
      title: "Editor",
      description: "Controls",
      hints: ""
    });

    const controls = createPromotedEditorControls({
      hud,
      initialSeed: 1,
      onTool(): void {},
      onBrush(): void {},
      onRectTool(): void {},
      onDefaultGround(): void {},
      onSeed(): void {},
      onRotate(): void {},
      onResetView(): void {},
      onClearStructures(): void {},
      onClearGround(): void {},
      onBake(): void {}
    });

    const exitButton = findByText(hud.root as unknown as FakeElement, "EXIT (F5)");
    expect(exitButton).not.toBeNull();
    (exitButton as FakeElement).trigger("click");
    expect(controls.seedInput).toBeDefined();
  });
});
