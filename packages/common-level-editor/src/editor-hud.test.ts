import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("createEditorHud", () => {
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

  it("creates shared HUD panels with stats/status/hints and test ids", () => {
    const mount = new FakeElement("div");
    const hud = createEditorHud({
      mount: mount as unknown as HTMLElement,
      title: "Editor",
      description: "Shared editor UI",
      hints: "H: help",
      statsTestId: "stats-id",
      statusTestId: "status-id"
    });

    expect(mount.children).toContain(hud.root as unknown as FakeElement);
    expect(hud.leftPanel.children[0]?.textContent).toBe("Editor");
    expect(hud.stats.dataset.testid).toBe("stats-id");
    expect(hud.status.dataset.testid).toBe("status-id");
    expect(hud.hints.textContent).toBe("H: help");
  });

  it("creates rows/buttons, applies active state, focuses target, and destroys cleanly", () => {
    const mount = new FakeElement("div");
    const focusTarget = new FakeElement("canvas");
    let clicked = 0;

    const hud = createEditorHud({
      mount: mount as unknown as HTMLElement,
      title: "Editor",
      description: "Shared editor UI",
      hints: "H: help",
      focusTarget: focusTarget as unknown as HTMLElement
    });

    const row = hud.createRow("Tools");
    const button = hud.createButton("Test", () => {
      clicked += 1;
    });
    row.appendChild(button as unknown as FakeElement);

    hud.setButtonActive(button, true);
    expect((button as unknown as FakeElement).style.background).toContain("78, 136, 177");

    (button as unknown as FakeElement).trigger("click");
    expect(clicked).toBe(1);
    expect(focusTarget.focusCalls).toHaveLength(1);

    hud.destroy();
    expect((hud.root as unknown as FakeElement).parentElement).toBeNull();
  });
});
