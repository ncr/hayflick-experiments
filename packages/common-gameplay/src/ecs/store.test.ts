import { describe, expect, it } from "vitest";
import { DataStore, TagStore } from "./store";

describe("DataStore", () => {
  it("supports basic component store operations", () => {
    const store = new DataStore<{ value: number }>();
    store.add(1, { value: 10 });
    store.add(2, { value: 20 });

    expect(store.has(1)).toBe(true);
    expect(store.get(2)).toEqual({ value: 20 });
    expect([...store.entries()]).toEqual([1, 2]);

    store.remove(1);
    expect(store.has(1)).toBe(false);
    store.clear();
    expect([...store.entries()]).toEqual([]);
  });
});

describe("TagStore", () => {
  it("stores and enumerates boolean tags", () => {
    const tags = new TagStore();
    tags.add(3, true);
    tags.add(5, true);

    expect(tags.has(3)).toBe(true);
    expect(tags.get(5)).toBe(true);
    expect([...tags.entries()]).toEqual([3, 5]);

    tags.remove(3);
    expect(tags.has(3)).toBe(false);
    tags.clear();
    expect([...tags.entries()]).toEqual([]);
  });
});
