import type { EID } from "./types";

// Component stores are intentionally simple: clarity and predictable behavior
// over sparse-array tricks. Stores expose the minimal ECS API surface.
export interface ComponentStore<T> {
  has(eid: EID): boolean;
  add(eid: EID, data: T): void;
  get(eid: EID): T | undefined;
  remove(eid: EID): void;
  entries(): Iterable<EID>;
  clear(): void;
}

export class DataStore<T> implements ComponentStore<T> {
  private readonly data = new Map<EID, T>();

  has(eid: EID): boolean {
    return this.data.has(eid);
  }

  add(eid: EID, value: T): void {
    this.data.set(eid, value);
  }

  get(eid: EID): T | undefined {
    return this.data.get(eid);
  }

  remove(eid: EID): void {
    this.data.delete(eid);
  }

  entries(): Iterable<EID> {
    return this.data.keys();
  }

  clear(): void {
    this.data.clear();
  }
}

export class TagStore implements ComponentStore<true> {
  private readonly tags = new Set<EID>();

  has(eid: EID): boolean {
    return this.tags.has(eid);
  }

  add(eid: EID, value: true): void {
    if (value) {
      this.tags.add(eid);
    }
  }

  get(eid: EID): true | undefined {
    return this.tags.has(eid) ? true : undefined;
  }

  remove(eid: EID): void {
    this.tags.delete(eid);
  }

  entries(): Iterable<EID> {
    return this.tags.values();
  }

  clear(): void {
    this.tags.clear();
  }
}
