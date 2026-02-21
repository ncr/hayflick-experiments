import { describe, expect, it } from "vitest";
import {
  createVhacdWorkerRunner,
  type WorkerRunRequest,
  type WorkerResponse
} from "./worker-runner";
import type { VhacdOptions, VhacdProgress, VhacdSerializedResult, VhacdSourceData } from "./vhacd";

type Listener = (event: unknown) => void;

class FakeWorker {
  private listeners: Record<string, Listener[]> = {
    message: [],
    error: []
  };

  terminated = false;
  postedMessages: unknown[] = [];

  constructor(private readonly onPostMessage?: (worker: FakeWorker, message: WorkerRunRequest) => void) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  postMessage(message: WorkerRunRequest): void {
    this.postedMessages.push(message);
    this.onPostMessage?.(this, message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(message: WorkerResponse): void {
    for (const listener of this.listeners.message ?? []) {
      listener({ data: message });
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error ?? []) {
      listener({ message });
    }
  }
}

const OPTIONS: VhacdOptions = {
  resolution: 128,
  concavity: 0.002,
  alpha: 0.05,
  beta: 0.05,
  sliverPenalty: 0.35,
  planeDownsampling: 1,
  convexHullDownsampling: 1,
  maxConvexHulls: 24,
  minVoxelCountPerPart: 24,
  maxHullPointSamples: 1800,
  projectHullVertices: true,
  projectHullMaxDistance: 0.18,
  precomputeBothHullVariants: true,
  maxGridCells: 20_000_000,
  voxelizationTriangleSampleCount: 12_000
};

const SOURCE_DATA: VhacdSourceData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
};

function makeSerializedResult(): VhacdSerializedResult {
  return {
    hulls: [],
    hullVariants: {
      projected: [],
      unprojected: []
    },
    activeHullVariant: "projected",
    voxelView: {
      voxelSize: 0.1,
      parts: []
    },
    stats: {
      sourceTriangleCount: 1,
      voxelCount: 12,
      voxelPreviewCount: 0,
      voxelSize: 0.1,
      rootVolume: 1,
      rootHullVolume: 1.2,
      rootConcavity: 0.2,
      splitCount: 1,
      mergeCount: 0,
      candidatePlaneCount: 4,
      iterationCount: 2,
      generatedBeforeMerge: 2,
      splitEvaluationMode: "parallel",
      splitWorkerCount: 4
    },
    signature: "sig",
    signatures: {
      projected: "sig-p",
      unprojected: "sig-u"
    }
  };
}

describe("createVhacdWorkerRunner", () => {
  it("forwards progress and resolves with deserialized results", async () => {
    const progressEvents: VhacdProgress[] = [];
    const serialized = makeSerializedResult();
    const worker = new FakeWorker((instance, request) => {
      instance.emitMessage({
        type: "progress",
        requestId: request.requestId + 42,
        progress: {
          phase: "collect",
          propProgress: 0.1,
          message: "ignored"
        }
      });
      instance.emitMessage({
        type: "progress",
        requestId: request.requestId,
        progress: {
          phase: "split",
          propProgress: 0.5,
          message: "Split level 1/3"
        }
      });
      instance.emitMessage({
        type: "result",
        requestId: request.requestId,
        result: serialized
      });
    });

    const runner = createVhacdWorkerRunner({
      createWorker: () => worker as unknown as Worker
    });
    const result = await runner.run(SOURCE_DATA, OPTIONS, (progress) => {
      progressEvents.push(progress);
    });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.phase).toBe("split");
    expect(result.stats.sourceTriangleCount).toBe(1);
    expect(result.signature).toBe("sig-p");
    runner.dispose();
  });

  it("rejects when worker sends an error message", async () => {
    const worker = new FakeWorker((instance, request) => {
      instance.emitMessage({
        type: "error",
        requestId: request.requestId,
        error: "failed"
      });
    });
    const runner = createVhacdWorkerRunner({
      createWorker: () => worker as unknown as Worker
    });

    await expect(runner.run(SOURCE_DATA, OPTIONS, () => {})).rejects.toThrow("failed");
    runner.dispose();
  });

  it("rejects pending run and restarts cleanly", async () => {
    const first = new FakeWorker();
    const second = new FakeWorker((instance, request) => {
      instance.emitMessage({
        type: "result",
        requestId: request.requestId,
        result: makeSerializedResult()
      });
    });
    let created = 0;
    const runner = createVhacdWorkerRunner({
      createWorker: () => {
        created += 1;
        return (created === 1 ? first : second) as unknown as Worker;
      }
    });

    const pending = runner.run(SOURCE_DATA, OPTIONS, () => {});
    runner.restart("superseded");
    await expect(pending).rejects.toThrow("superseded");
    expect(first.terminated).toBe(true);

    const nextResult = await runner.run(SOURCE_DATA, OPTIONS, () => {});
    expect(nextResult.signature).toBe("sig-p");
    runner.dispose();
  });

  it("reuses the same worker instance across sequential runs", async () => {
    let createCount = 0;
    const worker = new FakeWorker((instance, request) => {
      instance.emitMessage({
        type: "result",
        requestId: request.requestId,
        result: makeSerializedResult()
      });
    });
    const runner = createVhacdWorkerRunner({
      createWorker: () => {
        createCount += 1;
        return worker as unknown as Worker;
      }
    });

    await runner.run(SOURCE_DATA, OPTIONS, () => {});
    await runner.run(SOURCE_DATA, OPTIONS, () => {});
    expect(createCount).toBe(1);
    runner.dispose();
  });

  it("rejects concurrent calls while busy", async () => {
    const worker = new FakeWorker();
    const runner = createVhacdWorkerRunner({
      createWorker: () => worker as unknown as Worker
    });

    const pending = runner.run(SOURCE_DATA, OPTIONS, () => {});
    await expect(runner.run(SOURCE_DATA, OPTIONS, () => {})).rejects.toThrow("busy");
    runner.dispose();
    await expect(pending).rejects.toThrow("disposed");
  });

  it("rejects pending run on worker crash", async () => {
    const worker = new FakeWorker((instance) => {
      instance.emitError("crash");
    });
    const runner = createVhacdWorkerRunner({
      createWorker: () => worker as unknown as Worker
    });

    await expect(runner.run(SOURCE_DATA, OPTIONS, () => {})).rejects.toThrow("crash");
    expect(worker.terminated).toBe(true);
  });

  it("uses default Worker constructor when no factory is provided", async () => {
    const originalWorker = globalThis.Worker;
    const created: FakeWorker[] = [];

    class GlobalWorkerFake extends FakeWorker {
      constructor() {
        super((instance, request) => {
          instance.emitMessage({
            type: "result",
            requestId: request.requestId,
            result: makeSerializedResult()
          });
        });
        created.push(this);
      }
    }

    Object.assign(globalThis, {
      Worker: GlobalWorkerFake
    });

    try {
      const runner = createVhacdWorkerRunner();
      const result = await runner.run(SOURCE_DATA, OPTIONS, () => {});
      expect(created.length).toBe(1);
      expect(result.signature).toBe("sig-p");
      runner.dispose();
    } finally {
      if (originalWorker) {
        Object.assign(globalThis, { Worker: originalWorker });
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
    }
  });

  it("handles non-Error failures while deserializing worker payloads", async () => {
    const invalidSerialized = {
      get hullVariants() {
        throw "bad payload";
      }
    } as unknown as VhacdSerializedResult;

    const worker = new FakeWorker((instance, request) => {
      instance.emitMessage({
        type: "result",
        requestId: request.requestId,
        result: invalidSerialized
      });
    });

    const runner = createVhacdWorkerRunner({
      createWorker: () => worker as unknown as Worker
    });

    await expect(runner.run(SOURCE_DATA, OPTIONS, () => {})).rejects.toThrow(
      "Failed to deserialize VHACD worker result"
    );
  });
});
