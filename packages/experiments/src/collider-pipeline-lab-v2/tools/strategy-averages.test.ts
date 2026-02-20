import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { normalizePropGeometry } from "../pipeline/normalize";
import { runPipelineForProp } from "../pipeline/run-all";
import { DEFAULT_QUALITY_WEIGHTS, resolveDefaultStrategyParams } from "../state/defaults";
import type { NormalizedProp, StrategyId } from "../types";
import { ACTIVE_STRATEGY_IDS } from "../types";

type PropEntry = {
  id: string;
  modelPath: string;
};

type StrategyAggregate = {
  totalOverlap: number;
  totalFinal: number;
  totalRank: number;
  count: number;
};

const RUN_AVERAGES = process.env.COLLIDER_V2_STRATEGY_AVG === "1";
const maybeIt = RUN_AVERAGES ? it : it.skip;

function repoRootDir(): string {
  return path.resolve(process.cwd(), "..", "..");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listPropEntries(): Promise<PropEntry[]> {
  const propsRoot = path.resolve(repoRootDir(), "assets/forge/props");
  const entries = await readdir(propsRoot, { withFileTypes: true });
  const props: PropEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const id = entry.name;
    const processed = path.join(propsRoot, id, "processed", "model.glb");
    const raw = path.join(propsRoot, id, "raw", "tripo-output.glb");
    if (await exists(processed)) {
      props.push({ id, modelPath: processed });
      continue;
    }
    if (await exists(raw)) {
      props.push({ id, modelPath: raw });
    }
  }

  return props.sort((a, b) => a.id.localeCompare(b.id));
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

function initAggregates(): Record<StrategyId, StrategyAggregate> {
  return Object.fromEntries(
    ACTIVE_STRATEGY_IDS.map((id) => [
      id,
      {
        totalOverlap: 0,
        totalFinal: 0,
        totalRank: 0,
        count: 0
      }
    ])
  ) as Record<StrategyId, StrategyAggregate>;
}

function averageOrZero(total: number, count: number): number {
  return count <= 0 ? 0 : total / count;
}

maybeIt(
  "prints average overlap-based quality per strategy across all props",
  async () => {
    createNodeGltfShims();
    const propEntries = await listPropEntries();
    expect(propEntries.length).toBeGreaterThan(0);

    const aggregates = initAggregates();
    for (const entry of propEntries) {
      const group = await loadGlbAsGroup(entry.modelPath);
      const normalized: NormalizedProp = normalizePropGeometry(group, entry.id);
      const params = resolveDefaultStrategyParams(entry.id);
      const output = runPipelineForProp(normalized, params, DEFAULT_QUALITY_WEIGHTS);
      for (const result of output.strategyResults) {
        const aggregate = aggregates[result.strategyId];
        aggregate.totalOverlap += result.quality.overlapAgreement;
        aggregate.totalFinal += result.quality.finalScore;
        aggregate.totalRank += result.actualRank;
        aggregate.count += 1;
      }
    }

    const rows = ACTIVE_STRATEGY_IDS.map((strategyId) => {
      const aggregate = aggregates[strategyId];
      return {
        strategyId,
        avgOverlap: averageOrZero(aggregate.totalOverlap, aggregate.count),
        avgFinal: averageOrZero(aggregate.totalFinal, aggregate.count),
        avgRank: averageOrZero(aggregate.totalRank, aggregate.count)
      };
    }).sort((a, b) => {
      if (a.avgOverlap !== b.avgOverlap) {
        return b.avgOverlap - a.avgOverlap;
      }
      if (a.avgFinal !== b.avgFinal) {
        return a.avgFinal - b.avgFinal;
      }
      return a.strategyId.localeCompare(b.strategyId);
    });

    console.log(`[avg] props=${propEntries.length}`);
    for (const row of rows) {
      console.log(
        `[avg] ${row.strategyId} overlap=${row.avgOverlap.toFixed(6)} final=${row.avgFinal.toFixed(6)} avgRank=${row.avgRank.toFixed(3)}`
      );
    }
    const topFive = rows.slice(0, 5).map((row) => ({
      strategyId: row.strategyId,
      avgOverlap: Number(row.avgOverlap.toFixed(6)),
      avgFinal: Number(row.avgFinal.toFixed(6)),
      avgRank: Number(row.avgRank.toFixed(3))
    }));
    console.log(`[avg-top5] ${JSON.stringify(topFive)}`);

    expect(rows.length).toBe(ACTIVE_STRATEGY_IDS.length);
  },
  600_000
);

describe("strategy averages gate", () => {
  it("stays skipped unless COLLIDER_V2_STRATEGY_AVG=1", () => {
    expect(true).toBe(true);
  });
});
