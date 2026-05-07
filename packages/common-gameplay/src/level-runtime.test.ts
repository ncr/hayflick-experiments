import { describe, expect, it } from "vitest";
import { LevelRuntime } from "./level-runtime";

describe("LevelRuntime", () => {
  it("registers scene objects as ECS entities", () => {
    const attached: string[] = [];
    const runtime = new LevelRuntime<{ name: string }>({
      attach(node) {
        attached.push(node.name);
      }
    });

    const eid = runtime.addObject({
      id: "player",
      node: { name: "mesh:player" },
      transform: { x: 2, y: 3 },
      persistent: { kind: "player" }
    });

    expect(attached).toEqual(["mesh:player"]);
    expect(runtime.world.alive(eid)).toBe(true);
    expect(runtime.world.transforms.get(eid)).toEqual({ x: 2, y: 3 });
    expect(runtime.world.sceneRefs.get(eid)).toEqual({ id: "player" });
    expect(runtime.world.persistents.get(eid)).toEqual({ kind: "player" });
    expect(runtime.getObject("player")?.eid).toBe(eid);
    expect([...runtime.world.queryTransformSceneRef()]).toEqual([eid]);
  });

  it("steps systems in registration order", () => {
    const runtime = new LevelRuntime();
    const calls: string[] = [];

    runtime.addSystem((world) => {
      calls.push(`a:${world.time.frame}`);
    });
    runtime.addSystem((world) => {
      calls.push(`b:${world.time.frame}`);
    });

    runtime.step(0.25);

    expect(calls).toEqual(["a:1", "b:1"]);
    expect(runtime.world.time.dt).toBe(0.25);
    expect(runtime.world.time.t).toBe(0.25);
  });

  it("detaches, disposes, and destroys objects", () => {
    const detached: string[] = [];
    const disposed: string[] = [];
    const runtime = new LevelRuntime<{ name: string }>({
      detach(node) {
        detached.push(node.name);
      },
      disposeNode(node) {
        disposed.push(node.name);
      }
    });

    const eid = runtime.addObject({
      id: "crate",
      node: { name: "mesh:crate" }
    });

    expect(runtime.removeObject("crate")).toBe(true);
    expect(runtime.world.alive(eid)).toBe(false);
    expect(runtime.world.sceneRefs.has(eid)).toBe(false);
    expect(detached).toEqual(["mesh:crate"]);
    expect(disposed).toEqual(["mesh:crate"]);
    expect(runtime.removeObject("crate")).toBe(false);
  });
});
