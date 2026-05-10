export type PlacementSlot = {
  x: number;
  z: number;
  rotY: number;
};

export type PlacementFootprint = {
  width: number;
  depth: number;
};

function normalizedSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function rotatedSpan(width: number, depth: number, rotY: number): { x: number; z: number } {
  const cos = Math.abs(Math.cos(rotY));
  const sin = Math.abs(Math.sin(rotY));
  return {
    x: width * cos + depth * sin,
    z: width * sin + depth * cos
  };
}

function computeCenters(spans: number[], gap: number): number[] {
  if (spans.length <= 0) {
    return [];
  }

  const centers: number[] = [];
  let cursor = 0;
  for (const span of spans) {
    const safeSpan = normalizedSize(span);
    centers.push(cursor + safeSpan * 0.5);
    cursor += safeSpan + gap;
  }

  const totalSpan = cursor - gap;
  const offset = totalSpan * 0.5;
  return centers.map((center) => center - offset);
}

export function generatePropPlacements(
  footprints: PlacementFootprint[],
  roomRadius: number
): PlacementSlot[] {
  const placements: PlacementSlot[] = [];
  const cols = Math.ceil(Math.sqrt(footprints.length));
  const rows = Math.ceil(footprints.length / Math.max(cols, 1));
  const gap = Math.max(roomRadius * 0.2, 0.35);
  const columnWidths = new Array<number>(cols).fill(0);
  const rowDepths = new Array<number>(rows).fill(0);
  const slotMeta: Array<{ col: number; row: number; rotY: number }> = [];

  for (let i = 0; i < footprints.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const rotY = (i * 0.7) % (Math.PI * 2);
    const footprint = footprints[i]!;
    const width = normalizedSize(footprint.width);
    const depth = normalizedSize(footprint.depth);
    const span = rotatedSpan(width, depth, rotY);
    columnWidths[col] = Math.max(columnWidths[col] ?? 0, span.x);
    rowDepths[row] = Math.max(rowDepths[row] ?? 0, span.z);
    slotMeta.push({ col, row, rotY });
  }

  const xCenters = computeCenters(columnWidths, gap);
  const zCenters = computeCenters(rowDepths, gap);

  for (const slot of slotMeta) {
    placements.push({
      x: xCenters[slot.col] ?? 0,
      z: zCenters[slot.row] ?? 0,
      rotY: slot.rotY
    });
  }

  return placements;
}
