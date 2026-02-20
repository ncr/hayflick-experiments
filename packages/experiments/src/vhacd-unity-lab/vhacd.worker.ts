import {
  disposeVhacdResult,
  runVhacdFromSourceData,
  serializeVhacdResult,
  type VhacdOptions,
  type VhacdProgress,
  type VhacdSerializedResult,
  type VhacdSourceData
} from "./vhacd";

type WorkerRunRequest = {
  type: "run";
  requestId: number;
  sourceData: VhacdSourceData;
  options: VhacdOptions;
};

type WorkerProgressResponse = {
  type: "progress";
  requestId: number;
  progress: VhacdProgress;
};

type WorkerResultResponse = {
  type: "result";
  requestId: number;
  result: VhacdSerializedResult;
};

type WorkerErrorResponse = {
  type: "error";
  requestId: number;
  error: string;
};

function collectTransferables(result: VhacdSerializedResult): Transferable[] {
  const seen = new Set<ArrayBufferLike>();
  const transfers: Transferable[] = [];
  const pushHullBuffers = (hulls: VhacdSerializedResult["hulls"]): void => {
    for (const hull of hulls) {
      if (!seen.has(hull.positions.buffer)) {
        seen.add(hull.positions.buffer);
        transfers.push(hull.positions.buffer);
      }
      if (!seen.has(hull.indices.buffer)) {
        seen.add(hull.indices.buffer);
        transfers.push(hull.indices.buffer);
      }
    }
  };

  pushHullBuffers(result.hulls);
  if (result.hullVariants) {
    pushHullBuffers(result.hullVariants.projected);
    pushHullBuffers(result.hullVariants.unprojected);
  }
  for (const part of result.voxelView.parts) {
    if (seen.has(part.centers.buffer)) {
      continue;
    }
    seen.add(part.centers.buffer);
    transfers.push(part.centers.buffer);
  }
  return transfers;
}

const scope = self as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<WorkerRunRequest>) => void
  ) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

scope.addEventListener("message", (event: MessageEvent<WorkerRunRequest>) => {
  const message = event.data;
  if (!message || message.type !== "run") {
    return;
  }

  const { requestId, sourceData, options } = message;

  void (async () => {
    try {
      const result = await runVhacdFromSourceData(
        sourceData,
        options,
        (progress): void => {
          const progressMessage: WorkerProgressResponse = {
            type: "progress",
            requestId,
            progress
          };
          scope.postMessage(progressMessage);
        }
      );

      const serialized = serializeVhacdResult(result);
      disposeVhacdResult(result);

      const response: WorkerResultResponse = {
        type: "result",
        requestId,
        result: serialized
      };
      scope.postMessage(response, collectTransferables(serialized));
    } catch (error) {
      const response: WorkerErrorResponse = {
        type: "error",
        requestId,
        error: error instanceof Error ? error.message : String(error)
      };
      scope.postMessage(response);
    }
  })();
});
