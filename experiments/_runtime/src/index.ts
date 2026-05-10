/**
 * Type-only contract shared by:
 *   - studios under `studios/*`
 *   - experiments under `experiments/*`
 *   - the registry that aggregates both for the hub navigation
 *
 * This package has zero runtime deps so it can be imported anywhere
 * without inducing layering issues.
 */

export type ExperimentStatus = "draft" | "stable" | "archived";

/**
 * `strict` — engine-deps-only consumer (only `@common/*`). Used to harden
 *   core APIs against a real game-shaped consumer.
 * `free` — anything goes. Playground for raw three.js, ad-hoc deps,
 *   fast prototypes.
 *
 * Enforced by package.json deps + eslint-plugin-boundaries.
 *
 * Studios omit this field — they have their own layering rule
 * (only `@common/*` deps allowed) which is enforced separately.
 */
export type ExperimentMode = "strict" | "free";

export type ExperimentMeta = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  status: ExperimentStatus;
  mode?: ExperimentMode;
  updatedAt: string;
};

export type ExperimentContext = {
  mount: HTMLElement;
  width: number;
  height: number;
  dpr: number;
};

export type ExperimentModule = {
  id: string;
  title: string;
  tags: string[];
  init(ctx: ExperimentContext): Promise<() => void> | (() => void);
};

export type ExperimentRegistryEntry = ExperimentMeta & {
  load: () => Promise<{ default: ExperimentModule }>;
};
