import type { DebugMessage, DebugSink } from "@common/gameplay";

export type DebugSinkHandle = {
  sink: DebugSink;
  getMessages(): readonly DebugMessage[];
  subscribe(listener: () => void): () => void;
  clear(): void;
};

export function createDebugSink(opts: { maxEntries?: number } = {}): DebugSinkHandle {
  const max = Math.max(1, opts.maxEntries ?? 200);
  let messages: readonly DebugMessage[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const sink: DebugSink = {
    push(message) {
      const next = messages.length >= max ? messages.slice(-max + 1) : messages.slice();
      (next as DebugMessage[]).push(message);
      messages = next;
      notify();
    }
  };

  return {
    sink,
    getMessages() {
      return messages;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      messages = [];
      notify();
    }
  };
}
