import { describe, expect, it } from "vitest";
import {
  listSavedPropDefinitions,
  loadSavedPropColliderBinary,
  loadSavedPropBinary,
  makePropPlacementId
} from "./prop-library";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("prop library", () => {
  it("lists saved prop definitions from /api/fs", async () => {
    const fetchMock = async (input: string): Promise<Response> => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/fs/list") {
        return jsonResponse(["chair", "terminal"]);
      }

      const path = url.searchParams.get("path");
      if (path === "props/chair/meta.json") {
        return jsonResponse({
          content: JSON.stringify({
            description: "Lab Chair",
            processing: {
              bbox: { width: 0.75, height: 1.1, depth: 0.7 }
            },
            physics: {
              mobility: "dynamic",
              material: "glass",
              mass: 0.75,
              friction: 0.65,
              restitution: 0.05,
              linearDamping: 0.3,
              angularDamping: 0.4,
              activationDelayMs: 250
            },
            compoundCollider: {
              type: "compound-boxes",
              source: "auto-kmeans-v1",
              parts: [
                {
                  kind: "box",
                  position: [0, 0.2, 0],
                  halfExtents: [0.15, 0.2, 0.15]
                },
                {
                  kind: "box",
                  position: [0, 0.33, 0],
                  halfExtents: [0.08, 0.09, 0.08]
                }
              ]
            },
            colliderVariants: {
              box: {
                type: "box",
                source: "aabb-v1",
                position: [0, 0.55, 0],
                halfExtents: [0.375, 0.55, 0.35]
              },
              convexHull: {
                type: "convex-hull",
                source: "sampled-points-v1",
                points: [
                  [0.1, 0.1, 0.1],
                  [-0.1, 0.1, 0.1],
                  [0.1, -0.1, 0.1],
                  [0.1, 0.1, -0.1]
                ],
                rootOffset: [0, -0.5, 0]
              },
              compoundBoxes: {
                type: "compound-boxes",
                source: "auto-kmeans-v1",
                parts: [
                  {
                    kind: "box",
                    position: [0, 0.2, 0],
                    halfExtents: [0.15, 0.2, 0.15]
                  }
                ]
              }
            }
          })
        });
      }

      if (path === "props/terminal/meta.json") {
        return jsonResponse({
          content: JSON.stringify({
            description: "Mainframe",
            processing: {
              bbox: { width: 1.2, height: 1.6, depth: 0.9 }
            }
          })
        });
      }

      return new Response("not found", { status: 404 });
    };

    const defs = await listSavedPropDefinitions(fetchMock);
    expect(defs).toHaveLength(2);
    expect(defs[0]?.description).toBe("Lab Chair");
    expect(defs[0]?.collider2d).toEqual({ width: 0.75, depth: 0.7 });
    expect(defs[0]?.physicsHint?.mobility).toBe("dynamic");
    expect(defs[0]?.physicsHint?.material).toBe("glass");
    expect(defs[0]?.physicsHint?.activationDelayMs).toBe(250);
    expect(defs[0]?.compoundCollider?.type).toBe("compound-boxes");
    expect(defs[0]?.compoundCollider?.parts).toHaveLength(1);
    expect(defs[0]?.colliderVariants?.box?.type).toBe("box");
    expect(defs[0]?.colliderVariants?.convexHull?.type).toBe("convex-hull");
    expect(defs[0]?.colliderVariants?.compoundBoxes?.parts).toHaveLength(1);
    expect(defs[1]?.description).toBe("Mainframe");
    expect(defs[1]?.physicsHint).toBeUndefined();
    expect(defs[1]?.compoundCollider).toBeUndefined();
    expect(defs[1]?.colliderVariants?.box?.type).toBe("box");
    expect(defs[1]?.colliderVariants?.convexHull?.type).toBe("convex-hull");
  });

  it("falls back from processed to raw GLB", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = async (input: string): Promise<Response> => {
      const url = new URL(input, "http://localhost");
      const path = url.searchParams.get("path");
      if (path === "props/chair/processed/model.glb") {
        return new Response("missing", { status: 404 });
      }
      if (path === "props/chair/raw/tripo-output.glb") {
        return new Response(bytes, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const binary = await loadSavedPropBinary("chair", fetchMock);
    expect(binary).not.toBeNull();
    if (!binary) return;

    expect(new Uint8Array(binary)).toEqual(bytes);
  });

  it("prefers dedicated collider GLB for collider loading", async () => {
    const colliderBytes = new Uint8Array([9, 8, 7, 6]);
    const fetchMock = async (input: string): Promise<Response> => {
      const url = new URL(input, "http://localhost");
      const path = url.searchParams.get("path");
      if (path === "props/chair/processed/collider.glb") {
        return new Response(colliderBytes, { status: 200 });
      }
      if (path === "props/chair/processed/model.glb") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const binary = await loadSavedPropColliderBinary("chair", fetchMock);
    expect(binary).not.toBeNull();
    if (!binary) return;

    expect(new Uint8Array(binary)).toEqual(colliderBytes);
  });

  it("falls back to model then raw for collider loading", async () => {
    const modelBytes = new Uint8Array([5, 4, 3, 2]);
    const fetchMock = async (input: string): Promise<Response> => {
      const url = new URL(input, "http://localhost");
      const path = url.searchParams.get("path");
      if (path === "props/chair/processed/collider.glb") {
        return new Response("missing", { status: 404 });
      }
      if (path === "props/chair/processed/model.glb") {
        return new Response(modelBytes, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const binary = await loadSavedPropColliderBinary("chair", fetchMock);
    expect(binary).not.toBeNull();
    if (!binary) return;

    expect(new Uint8Array(binary)).toEqual(modelBytes);
  });

  it("creates stable placement ids", () => {
    expect(makePropPlacementId("lab chair", 3, 4, 2)).toBe("lab-chair:3,4:2");
  });
});
