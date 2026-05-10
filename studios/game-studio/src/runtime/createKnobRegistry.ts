import type {
  KnobEntry,
  KnobRegistry,
  KnobNumberSpec,
  KnobSelectSpec,
  KnobSpec,
  KnobToggleSpec
} from "@common/gameplay";

export function createKnobRegistry(): KnobRegistry {
  const specs = new Map<string, KnobSpec>();
  const values = new Map<string, unknown>();
  const order: string[] = [];
  const listeners = new Set<() => void>();
  let cachedEntries: readonly KnobEntry[] | null = null;

  const notify = () => {
    cachedEntries = null;
    for (const listener of listeners) {
      listener();
    }
  };

  const upsertSpec = (spec: KnobSpec) => {
    if (specs.has(spec.key)) {
      return;
    }
    specs.set(spec.key, spec);
    values.set(spec.key, spec.default);
    order.push(spec.key);
    notify();
  };

  const buildEntries = (): readonly KnobEntry[] => {
    if (cachedEntries) {
      return cachedEntries;
    }
    cachedEntries = order.map((key) => {
      const spec = specs.get(key)!;
      return {
        spec,
        get: () => values.get(key),
        set: (value: unknown) => {
          values.set(key, value);
          notify();
        }
      };
    });
    return cachedEntries;
  };

  return {
    number(key, opts) {
      const spec: KnobNumberSpec = {
        kind: "number",
        key,
        min: opts.min,
        max: opts.max,
        default: opts.default,
        step: opts.step
      };
      upsertSpec(spec);
      return () => values.get(key) as number;
    },
    toggle(key, opts) {
      const spec: KnobToggleSpec = {
        kind: "toggle",
        key,
        default: opts.default
      };
      upsertSpec(spec);
      return () => values.get(key) as boolean;
    },
    select<T extends string>(
      key: string,
      opts: { options: readonly T[]; default: T }
    ): () => T {
      const spec: KnobSelectSpec = {
        kind: "select",
        key,
        options: opts.options,
        default: opts.default
      };
      upsertSpec(spec);
      return () => values.get(key) as T;
    },
    entries() {
      return buildEntries();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
