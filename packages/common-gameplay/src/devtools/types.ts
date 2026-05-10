import type { World } from "../ecs/world";
import type { DebugSink } from "../ecs/types";
import type { KeyboardTracker, SystemPipeline } from "../ecs/systems";

// Contract types between a game-studio shell and a playable game module.
// Generic `TNode` keeps gameplay three-agnostic; the studio specializes it
// (typically with `THREE.Object3D`).

export type KnobNumberSpec = {
  kind: "number";
  key: string;
  default: number;
  min: number;
  max: number;
  step?: number;
};

export type KnobToggleSpec = {
  kind: "toggle";
  key: string;
  default: boolean;
};

export type KnobSelectSpec = {
  kind: "select";
  key: string;
  options: readonly string[];
  default: string;
};

export type KnobSpec = KnobNumberSpec | KnobToggleSpec | KnobSelectSpec;

export type KnobEntry = {
  readonly spec: KnobSpec;
  get(): unknown;
  set(value: unknown): void;
};

export type KnobRegistry = {
  number(
    key: string,
    opts: { min: number; max: number; default: number; step?: number }
  ): () => number;
  toggle(key: string, opts: { default: boolean }): () => boolean;
  select<T extends string>(
    key: string,
    opts: { options: readonly T[]; default: T }
  ): () => T;
  entries(): readonly KnobEntry[];
  subscribe(listener: () => void): () => void;
};

export type GameStudioContext<TNode = unknown> = {
  rootNode: TNode;
  world: World;
  keyboard: KeyboardTracker;
  debug: DebugSink;
  knobs: KnobRegistry;
  width: number;
  height: number;
};

export type GameInstance = {
  systems: SystemPipeline;
  step?: (dt: number) => void;
  dispose(): void;
};

export type GameModule<TNode = unknown> = {
  id: string;
  title: string;
  description?: string;
  create(ctx: GameStudioContext<TNode>): GameInstance | Promise<GameInstance>;
};
