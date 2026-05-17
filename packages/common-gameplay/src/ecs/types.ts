export type EID = number;

export type Transform = {
  x: number;
  y: number;
};

export type Velocity = {
  vx: number;
  vy: number;
};

/**
 * Marks an entity as input-controlled on the iso lattice. The engine's
 * input system writes velocity into every entity with this component,
 * scaling by `speed` (in screen pixels per second). Speed can be a getter
 * so live-knob tracking works without re-adding the component each frame.
 *
 * The component is intentionally not serialized — function speeds can't
 * round-trip through JSON, and on load the game's setup re-attaches the
 * binding anyway.
 */
export type Controlled = {
  speed: number | (() => number);
};

export type Persistent = {
  kind: string;
};

export type SceneRef = {
  id: string;
};

export type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  savePressed: boolean;
  loadPressed: boolean;
};

export type TimeResource = {
  dt: number;
  t: number;
  frame: number;
};

export type LevelSnapshot = {
  id: string;
  version: number;
};

export type LevelResource = {
  id: string;
  version: number;
  isBlocked(x: number, y: number): boolean;
};

export type LevelResolver = (snapshot: LevelSnapshot) => LevelResource;

export type EcsEvent =
  | { type: "Moved"; e: EID }
  | { type: "BumpedWall"; e: EID };

export type SaveEntityRecord = {
  components: {
    Transform?: Transform;
    Velocity?: Velocity;
    Persistent?: Persistent;
  };
};

export type SaveGame = {
  schemaVersion: number;
  level: LevelSnapshot;
  time: {
    t: number;
  };
  entities: SaveEntityRecord[];
};

export type DebugMessage = {
  frame: number;
  message: string;
};

export type DebugSink = {
  push(message: DebugMessage): void;
};

export type WorldOptions = {
  level?: LevelResource;
  resolveLevel?: LevelResolver;
};
