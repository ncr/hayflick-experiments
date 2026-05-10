/* @vitest-environment node */

import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultForgeMeta } from "@studios/forge/internal/state/schema";
import { ForgeStore } from "./forge-store";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=";

describe("forge store", () => {
  it("persists prop stage commands and rebuilds the generated index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-store-"));
    const store = new ForgeStore(root);

    const meta = createDefaultForgeMeta({
      id: "crate",
      description: "cargo crate",
      styleGuide: {
        name: "Test",
        prompt: "test prompt",
        negativePrompt: "",
        imageSize: "1024x1024",
      },
      composedPrompt: "test prompt cargo crate",
      faceLimit: 5000,
      pbr: true,
    });

    await store.createProp(meta);

    const imageMeta = {
      ...meta,
      lifecycle: { status: "image-ready" as const },
    };
    await store.saveReferenceStage({
      propId: meta.id,
      meta: imageMeta,
      conceptImageDataUrl: PNG_DATA_URL,
      prompt: "saved prompt",
    });

    const meshMeta = {
      ...imageMeta,
      lifecycle: { status: "mesh-ready" as const },
    };
    await store.saveMeshStage({
      propId: meta.id,
      meta: meshMeta,
      rawGlbBase64: Buffer.from("raw-glb").toString("base64"),
      processedGlbBase64: Buffer.from("processed-glb").toString("base64"),
    });

    const physicsMeta = {
      ...meshMeta,
      lifecycle: { status: "physics-ready" as const },
    };
    await store.savePhysicsStage({
      propId: meta.id,
      meta: physicsMeta,
      colliderGlbs: [
        {
          presetId: "balanced",
          glbBase64: Buffer.from("collider-glb").toString("base64"),
        },
      ],
    });

    const list = await store.listProps();
    expect(list).toEqual([
      expect.objectContaining({
        id: "crate",
        description: "cargo crate",
        status: "physics-ready",
        hasConceptImage: true,
      }),
    ]);

    const record = await store.getProp("crate");
    expect(record?.meta.lifecycle?.status).toBe("physics-ready");
    expect(record?.hasConceptImage).toBe(true);

    await expect(
      readFile(path.join(root, "props", "crate", "raw", "prompt.txt"), "utf8")
    ).resolves.toBe("saved prompt");
    await expect(
      readFile(path.join(root, "props", "crate", "processed", "colliders", "balanced.glb"), "utf8")
    ).resolves.toBe("collider-glb");
    await expect(stat(path.join(root, "index.json"))).resolves.toBeDefined();
  });
});
