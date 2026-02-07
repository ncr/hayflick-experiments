import type { EcsEvent } from "./types";

// Event bus: queue during systems, then explicitly drain at a known frame point.
export class EventBus {
  private readonly queue: EcsEvent[] = [];

  emit(event: EcsEvent): void {
    this.queue.push(event);
  }

  drain(): EcsEvent[] {
    const drained = this.queue.slice();
    this.queue.length = 0;
    return drained;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
