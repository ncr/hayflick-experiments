/**
 * AutoSaver — debounced persistence to disk.
 *
 * Instead of writing to disk on every slider tick, the AutoSaver waits for
 * a configurable quiet period (default 10s) after the last `markDirty()` call
 * before actually persisting. This prevents disk spam while ensuring work is
 * eventually saved.
 *
 * Call `flush()` to force an immediate save (e.g., on tab switch, unmount).
 */

export type SaveCallback = (propId: string) => Promise<void>;
export type StatusCallback = (status: SaveStatus) => void;

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export class AutoSaver {
  private dirtyProps = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private disposed = false;

  constructor(
    private saveFn: SaveCallback,
    private onStatus: StatusCallback,
    private debounceMs = 10_000,
  ) {}

  /** Mark a prop as needing a save. Resets the debounce timer. */
  markDirty(propId: string): void {
    if (this.disposed) return;
    this.dirtyProps.add(propId);
    this.onStatus("dirty");
    this.resetTimer();
  }

  /** Force immediate save of all dirty props. */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.persist();
  }

  /** Cleanup: flush pending saves and stop. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    await this.persist();
  }

  /** Check if there are unsaved changes. */
  get isDirty(): boolean {
    return this.dirtyProps.size > 0;
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.persist();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async persist(): Promise<void> {
    if (this.saving || this.dirtyProps.size === 0) return;
    this.saving = true;
    this.onStatus("saving");

    // Snapshot and clear the dirty set so new marks during save start a new cycle
    const propIds = [...this.dirtyProps];
    this.dirtyProps.clear();

    try {
      for (const propId of propIds) {
        if (this.disposed) break;
        await this.saveFn(propId);
      }
      this.onStatus(this.dirtyProps.size > 0 ? "dirty" : "saved");
    } catch {
      // Re-add failed props so they get retried
      for (const id of propIds) {
        this.dirtyProps.add(id);
      }
      this.onStatus("error");
    } finally {
      this.saving = false;
    }
  }
}
