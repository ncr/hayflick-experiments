export type HistoryController<T> = {
  canUndo(): boolean;
  canRedo(): boolean;
  push(snapshot: T): void;
  undo(current: T): T | null;
  redo(current: T): T | null;
  clear(): void;
};

export function createHistoryController<T>(options: {
  maxEntries: number;
  clone(value: T): T;
}): HistoryController<T> {
  const undoStack: T[] = [];
  const redoStack: T[] = [];

  function push(snapshot: T): void {
    undoStack.push(options.clone(snapshot));
    if (undoStack.length > options.maxEntries) {
      undoStack.shift();
    }
    redoStack.length = 0;
  }

  function undo(current: T): T | null {
    const next = undoStack.pop();
    if (next === undefined) {
      return null;
    }
    redoStack.push(options.clone(current));
    return options.clone(next);
  }

  function redo(current: T): T | null {
    const next = redoStack.pop();
    if (next === undefined) {
      return null;
    }
    undoStack.push(options.clone(current));
    if (undoStack.length > options.maxEntries) {
      undoStack.shift();
    }
    return options.clone(next);
  }

  function clear(): void {
    undoStack.length = 0;
    redoStack.length = 0;
  }

  return {
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    push,
    undo,
    redo,
    clear
  };
}
