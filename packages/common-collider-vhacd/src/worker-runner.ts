import {
  deserializeVhacdResult,
  type VhacdOptions,
  type VhacdProgress,
  type VhacdResult,
  type VhacdSerializedResult,
  type VhacdSourceData
} from "./vhacd";

export type WorkerRunRequest = {
  type: "run";
  requestId: number;
  sourceData: VhacdSourceData;
  options: VhacdOptions;
};

export type WorkerProgressResponse = {
  type: "progress";
  requestId: number;
  progress: VhacdProgress;
};

export type WorkerResultResponse = {
  type: "result";
  requestId: number;
  result: VhacdSerializedResult;
};

export type WorkerErrorResponse = {
  type: "error";
  requestId: number;
  error: string;
};

export type WorkerResponse = WorkerProgressResponse | WorkerResultResponse | WorkerErrorResponse;

type PendingWorkerRequest = {
  requestId: number;
  resolve: (result: VhacdResult) => void;
  reject: (error: Error) => void;
  onProgress: (progress: VhacdProgress) => void;
};

export type VhacdWorkerRunner = {
  run: (
    sourceData: VhacdSourceData,
    options: VhacdOptions,
    onProgress: (progress: VhacdProgress) => void
  ) => Promise<VhacdResult>;
  restart: (reason?: string) => void;
  dispose: () => void;
};

export type VhacdWorkerRunnerOptions = {
  createWorker?: () => Worker;
};

export function createVhacdWorkerRunner(options: VhacdWorkerRunnerOptions = {}): VhacdWorkerRunner {
  let worker: Worker | null = null;
  let pending: PendingWorkerRequest | null = null;
  let nextRequestId = 1;

  const terminateWorker = (reason: string): void => {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (pending) {
      const request = pending;
      pending = null;
      request.reject(new Error(reason));
    }
  };

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }

    const instance =
      options.createWorker?.() ??
      new Worker(new URL("./vhacd.worker.ts", import.meta.url), {
        type: "module"
      });

    instance.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!pending || message.requestId !== pending.requestId) {
        return;
      }

      if (message.type === "progress") {
        pending.onProgress(message.progress);
        return;
      }

      if (message.type === "error") {
        const request = pending;
        pending = null;
        request.reject(new Error(message.error || "VHACD worker failed"));
        return;
      }

      const request = pending;
      pending = null;
      try {
        request.resolve(deserializeVhacdResult(message.result));
      } catch (error) {
        request.reject(
          error instanceof Error ? error : new Error("Failed to deserialize VHACD worker result")
        );
      }
    });

    instance.addEventListener("error", (event: ErrorEvent) => {
      const detail = event.message?.trim().length ? event.message : "unknown error";
      terminateWorker(`VHACD worker crashed: ${detail}`);
    });

    worker = instance;
    return instance;
  };

  const run = (
    sourceData: VhacdSourceData,
    inputOptions: VhacdOptions,
    onProgress: (progress: VhacdProgress) => void
  ): Promise<VhacdResult> => {
    if (pending) {
      return Promise.reject(new Error("VHACD worker is busy"));
    }

    return new Promise<VhacdResult>((resolve, reject) => {
      const requestId = nextRequestId;
      nextRequestId += 1;
      pending = {
        requestId,
        resolve,
        reject,
        onProgress
      };

      const request: WorkerRunRequest = {
        type: "run",
        requestId,
        sourceData,
        options: inputOptions
      };

      ensureWorker().postMessage(request);
    });
  };

  return {
    run,
    restart: (reason = "VHACD run canceled"): void => {
      terminateWorker(reason);
    },
    dispose: (): void => {
      terminateWorker("VHACD worker disposed");
    }
  };
}
