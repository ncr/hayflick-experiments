import { readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { runPipelineForProp } from "../pipeline/run-all";
import {
  DEFAULT_QUALITY_WEIGHTS,
  resolveDefaultStrategyParams
} from "../state/defaults";
import { scoreColliderQuality } from "../pipeline/score";
import { generateBoxyFurnitureLegacyCollider, generateConcaveFurnitureLegacyCollider } from "../strategies/legacy-ported";
import type { StrategyResult } from "../types";
import { ACTIVE_STRATEGY_IDS } from "../types";
import { normalizePropGeometry } from "../pipeline/normalize";

const RUN_DIAGNOSE = process.env.COLLIDER_V2_DIAGNOSE_RANK === "1";
const maybeIt = RUN_DIAGNOSE ? it : it.skip;

function repoRootDir(): string {
  return path.resolve(process.cwd(), "..", "..");
}

function createNodeGltfShims(): void {
  const globalScope = globalThis as unknown as {
    self?: unknown;
    createImageBitmap?: typeof globalThis.createImageBitmap;
  };
  if (typeof globalScope.self === "undefined") {
    globalScope.self = globalThis;
  }
  if (typeof globalScope.createImageBitmap === "undefined") {
    globalScope.createImageBitmap = (async () =>
      ({
        width: 1,
        height: 1,
        close() {
          // no-op shim for Node runtime
        }
      }) as unknown as ImageBitmap) as typeof globalThis.createImageBitmap;
  }
}

async function loadGlbAsGroup(filePath: string): Promise<THREE.Group> {
  const raw = await readFile(filePath);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength
  ) as ArrayBuffer;
  const loader = new GLTFLoader();
  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      "",
      (gltf) => resolve((gltf.scene ?? new THREE.Group()) as THREE.Group),
      (error) => reject(error)
    );
  });
}

function printResultRow(result: StrategyResult): void {
  console.log(
    [
      `${String(result.actualRank).padStart(2, " ")}`,
      result.strategyId.padEnd(18, " "),
      `score=${result.quality.finalScore.toFixed(5)}`,
      `iou=${result.quality.voxelIoU.toFixed(3)}`,
      `overlap=${result.quality.overlapAgreement.toFixed(3)}`,
      `meshHit=${result.quality.meshOverlap.toFixed(3)}`,
      `colHit=${result.quality.colliderOverlap.toFixed(3)}`,
      `selfOv=${result.quality.colliderSelfOverlap.toFixed(3)}`,
      `underfill=${result.quality.underfill.toFixed(3)}`,
      `overfill=${result.quality.overfill.toFixed(3)}`,
      `thin=${result.quality.thinPenalty.toFixed(3)}`,
      `partsPen=${result.quality.partPenalty.toFixed(3)}`,
      `base=${result.quality.flatBaseBonus.toFixed(3)}`,
      `parts=${result.parts.length}`
    ].join(" | ")
  );
}

maybeIt("diagnose large-desk-without-drawers ranking details", async () => {
  createNodeGltfShims();
  const filePath = path.resolve(
    repoRootDir(),
    "assets/forge/props/large-desk-without-drawers/processed/model.glb"
  );
  const group = await loadGlbAsGroup(filePath);
  const normalized = normalizePropGeometry(group, "large-desk-without-drawers");
  const params = resolveDefaultStrategyParams("large-desk-without-drawers");
  const result = runPipelineForProp(normalized, params, DEFAULT_QUALITY_WEIGHTS);

  console.log(`strategies: ${ACTIVE_STRATEGY_IDS.length}`);
  const ordered = result.strategyResults
    .slice()
    .sort((a, b) => a.actualRank - b.actualRank);
  for (const row of ordered) {
    printResultRow(row);
  }

  const concave = result.strategyResults.find(
    (entry) => entry.strategyId === "concave-furniture"
  );
  expect(concave).toBeDefined();
  if (!concave) {
    return;
  }
  console.log("---- concave-furniture params ----");
  console.log(JSON.stringify(params["concave-furniture"], null, 2));
  console.log("---- concave-furniture quality ----");
  console.log(JSON.stringify(concave.quality, null, 2));
  console.log("---- concave-furniture parts ----");
  for (const [index, part] of concave.parts.entries()) {
    const sx = part.halfExtents[0] * 2;
    const sy = part.halfExtents[1] * 2;
    const sz = part.halfExtents[2] * 2;
    const maxEdge = Math.max(sx, sy, sz, 1e-6);
    const minEdge = Math.min(sx, sy, sz);
    const aspect = minEdge / maxEdge;
    console.log(
      `${index.toString().padStart(2, "0")} | size=(${sx.toFixed(3)}, ${sy.toFixed(3)}, ${sz.toFixed(3)}) | aspect=${aspect.toFixed(3)} | volume=${part.volume.toFixed(4)}`
    );
  }

  const variants = [
    { mode: 0, budget: 0, maxParts: 12, inflate: 0.004 },
    { mode: 1, budget: 0, maxParts: 12, inflate: 0.004 },
    { mode: 1, budget: 1, maxParts: 12, inflate: 0.004 },
    { mode: 1, budget: 1, maxParts: 16, inflate: 0.006 },
    { mode: 1, budget: 0, maxParts: 16, inflate: 0.008 },
    { mode: 1, budget: 1, maxParts: 24, inflate: 0.008 }
  ] as const;
  console.log("---- concave variants ----");
  for (const variant of variants) {
    const parts = generateConcaveFurnitureLegacyCollider(normalized, variant);
    const quality = scoreColliderQuality(normalized, parts, DEFAULT_QUALITY_WEIGHTS);
    console.log(
      `variant=${JSON.stringify(variant)} | score=${quality.finalScore.toFixed(5)} | iou=${quality.voxelIoU.toFixed(3)} | underfill=${quality.underfill.toFixed(3)} | overfill=${quality.overfill.toFixed(3)} | thin=${quality.thinPenalty.toFixed(3)} | parts=${parts.length}`
    );
  }
  console.log("---- boxy variants ----");
  for (const variant of variants) {
    const parts = generateBoxyFurnitureLegacyCollider(normalized, variant);
    const quality = scoreColliderQuality(normalized, parts, DEFAULT_QUALITY_WEIGHTS);
    console.log(
      `variant=${JSON.stringify(variant)} | score=${quality.finalScore.toFixed(5)} | iou=${quality.voxelIoU.toFixed(3)} | underfill=${quality.underfill.toFixed(3)} | overfill=${quality.overfill.toFixed(3)} | thin=${quality.thinPenalty.toFixed(3)} | parts=${parts.length}`
    );
  }
}, 20_000);

describe("manual diagnose gate", () => {
  it("stays skipped unless COLLIDER_V2_DIAGNOSE_RANK=1", () => {
    expect(true).toBe(true);
  });
});
