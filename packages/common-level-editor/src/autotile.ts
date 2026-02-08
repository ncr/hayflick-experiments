export type AutoTileShape = "isolated" | "end" | "straight" | "corner" | "tee" | "cross";

export type AutoTileDescriptor = {
  shape: AutoTileShape;
  rotation: 0 | 1 | 2 | 3;
};

function normalizeQuarterTurns(value: number): 0 | 1 | 2 | 3 {
  return (((Math.floor(value) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

// Cardinal mask bits: N=1, E=2, S=4, W=8.
export function describeAutoTile(mask: number): AutoTileDescriptor {
  const normalizedMask = mask & 0b1111;

  if (normalizedMask === 0) return { shape: "isolated", rotation: 0 };
  if (normalizedMask === 1) return { shape: "end", rotation: 0 };
  if (normalizedMask === 2) return { shape: "end", rotation: 1 };
  if (normalizedMask === 4) return { shape: "end", rotation: 2 };
  if (normalizedMask === 8) return { shape: "end", rotation: 3 };

  if (normalizedMask === 5) return { shape: "straight", rotation: 0 };
  if (normalizedMask === 10) return { shape: "straight", rotation: 1 };

  if (normalizedMask === 3) return { shape: "corner", rotation: 0 };
  if (normalizedMask === 6) return { shape: "corner", rotation: 1 };
  if (normalizedMask === 12) return { shape: "corner", rotation: 2 };
  if (normalizedMask === 9) return { shape: "corner", rotation: 3 };

  if (normalizedMask === 11) return { shape: "tee", rotation: 0 };
  if (normalizedMask === 7) return { shape: "tee", rotation: 1 };
  if (normalizedMask === 14) return { shape: "tee", rotation: 2 };
  if (normalizedMask === 13) return { shape: "tee", rotation: 3 };

  return { shape: "cross", rotation: 0 };
}

// Ground-plane overlays are authored with "north" toward -Z in world space.
// A clockwise quarter-turn therefore maps to a negative world-Y angle.
export function autoTileRotationRadians(rotation: number): number {
  return -normalizeQuarterTurns(rotation) * Math.PI * 0.5;
}
