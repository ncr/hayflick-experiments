import * as THREE from "three";
import type { GridConfig, MapEditorState, PlacedEdge, PlacedCell, PlacedVertex } from "./editor-state";
import type { TilesetAssets } from "./tileset-loader";

// Layer 0 = default: grid, terrain, 3D originals (both cameras)
// Layer 2 = 2D tinted clones (only 2D camera sees these)
export const LAYER_2D_TINT = 2;

const TINT_COLOR_BY_KIND: Record<string, number> = {
  wall: 0xd0d8e0,
  door_wall: 0xcc7722,
  window_module: 0x5599cc,
  corner: 0xd0d8e0,
  end_cap: 0xd0d8e0,
  floor_tile: 0x9e9484
};
const DEFAULT_TINT = 0xaabbcc;

export class SceneBuilder {
  readonly root = new THREE.Group();
  /** Ghost preview group — sits on layer 2 so only 2D camera sees it */
  readonly preview = new THREE.Group();
  private readonly tintMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private ghostMaterial: THREE.MeshBasicMaterial;
  private lastRevision = -1;
  private lastPreviewKey = "";

  constructor(private readonly assets: TilesetAssets) {
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcc44,
      transparent: true,
      opacity: 0.4,
      depthTest: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
  }

  update(state: MapEditorState): void {
    if (state.revision === this.lastRevision) return;
    this.lastRevision = state.revision;
    this.rebuild(state);
  }

  /** Force preview to redraw on next setPreview call */
  invalidatePreview(): void {
    this.lastPreviewKey = "";
  }

  /** Show a ghost preview of the given tile at a world position with rotation */
  setPreview(tileName: string | null, worldX: number, worldZ: number, yaw: number): void {
    const key = tileName ? `${tileName}:${worldX.toFixed(3)}:${worldZ.toFixed(3)}:${yaw.toFixed(3)}` : "";
    if (key === this.lastPreviewKey) return;
    this.lastPreviewKey = key;

    clearGroup(this.preview);
    if (!tileName) return;

    const loaded = this.assets.tiles.get(tileName);
    if (!loaded) return;

    const ghost = loaded.template.clone();
    ghost.position.set(worldX, 0, worldZ);
    ghost.rotation.y = yaw;
    replaceMaterialsRecursive(ghost, this.ghostMaterial);
    setLayerRecursive(ghost, LAYER_2D_TINT);
    this.preview.add(ghost);
  }

  clearPreview(): void {
    if (this.lastPreviewKey === "") return;
    this.lastPreviewKey = "";
    clearGroup(this.preview);
  }

  dispose(): void {
    this.ghostMaterial.dispose();
    for (const mat of this.tintMaterials.values()) mat.dispose();
    clearGroup(this.root);
    clearGroup(this.preview);
  }

  private rebuild(state: MapEditorState): void {
    clearGroup(this.root);

    for (const edge of state.edgeStructures.values()) {
      this.placeEdge(edge, state.grid);
    }
    for (const cell of state.cellStructures.values()) {
      this.placeCell(cell, state.grid);
    }
    for (const vtx of state.vertexStructures.values()) {
      this.placeVertex(vtx, state.grid);
    }
  }

  private placeEdge(structure: PlacedEdge, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + ((structure.ax + structure.bx) / 2) * grid.tileSize;
    const worldZ = grid.origin + ((structure.az + structure.bz) / 2) * grid.tileSize;
    const isVertical = structure.ax === structure.bx;
    const yaw = isVertical ? Math.PI / 2 : 0;

    this.addOriginalAndTint(loaded.template, loaded.entry.kind, worldX, worldZ, yaw);
  }

  private placeVertex(structure: PlacedVertex, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + structure.x * grid.tileSize;
    const worldZ = grid.origin + structure.z * grid.tileSize;
    const yaw = (structure.rotation & 3) * (Math.PI / 2);

    this.addOriginalAndTint(loaded.template, loaded.entry.kind, worldX, worldZ, yaw);
  }

  private placeCell(structure: PlacedCell, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + (structure.x + 0.5) * grid.tileSize;
    const worldZ = grid.origin + (structure.z + 0.5) * grid.tileSize;

    this.addOriginalAndTint(loaded.template, loaded.entry.kind, worldX, worldZ, 0);
  }

  private addOriginalAndTint(
    template: THREE.Group,
    kind: string,
    worldX: number,
    worldZ: number,
    yaw: number
  ): void {
    // 3D original on layer 0 — both cameras see it
    const original = template.clone();
    original.position.set(worldX, 0, worldZ);
    original.rotation.y = yaw;
    this.root.add(original);

    // 2D tinted clone on layer 2 — only 2D camera sees it
    const tinted = template.clone();
    tinted.position.set(worldX, 0, worldZ);
    tinted.rotation.y = yaw;
    const tintColor = TINT_COLOR_BY_KIND[kind] ?? DEFAULT_TINT;
    const tintMat = this.getTintMaterial(kind, tintColor);
    replaceMaterialsRecursive(tinted, tintMat);
    setLayerRecursive(tinted, LAYER_2D_TINT);
    this.root.add(tinted);
  }

  private getTintMaterial(key: string, color: number): THREE.MeshBasicMaterial {
    let mat = this.tintMaterials.get(key);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      this.tintMaterials.set(key, mat);
    }
    return mat;
  }
}

function setLayerRecursive(obj: THREE.Object3D, layer: number): void {
  obj.layers.set(layer);
  for (const child of obj.children) {
    setLayerRecursive(child, layer);
  }
}

function replaceMaterialsRecursive(obj: THREE.Object3D, mat: THREE.Material): void {
  if (obj instanceof THREE.Mesh) {
    obj.material = mat;
  }
  for (const child of obj.children) {
    replaceMaterialsRecursive(child, mat);
  }
}

function clearGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    if (child instanceof THREE.Group) {
      clearGroup(child);
    }
  }
}
