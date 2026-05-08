export type LevelAssetOptions = Record<string, unknown>;

export type LevelPlacement = {
  id: string;
  asset: string;
  options: LevelAssetOptions;
};

export type AuthoredLevel = {
  id: string;
  title: string;
  placements: readonly LevelPlacement[];
};

export type LevelAuthor = {
  place(id: string, asset: string, options?: LevelAssetOptions): void;
};

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Level ${label} must be a non-empty string.`);
  }
}

export function defineLevel(
  input: { id: string; title: string },
  build: (level: LevelAuthor) => void
): AuthoredLevel {
  requireNonEmpty(input.id, "id");
  requireNonEmpty(input.title, "title");

  const placements: LevelPlacement[] = [];
  const ids = new Set<string>();

  const author: LevelAuthor = {
    place(id, asset, options = {}) {
      requireNonEmpty(id, "placement id");
      requireNonEmpty(asset, "asset reference");

      if (ids.has(id)) {
        throw new Error(`Level placement id is already used: ${id}`);
      }

      ids.add(id);
      placements.push({ id, asset, options: { ...options } });
    }
  };

  build(author);

  return {
    id: input.id,
    title: input.title,
    placements
  };
}
