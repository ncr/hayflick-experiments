import * as THREE from "three";
import type { GridConfig, MapEditorState, PlacedEdge, PlacedCell, PlacedVertex } from "./editor-state";
import type { TilesetAssets } from "./tileset-loader";

// Layer 0 = default: placed structures, both cameras see them
// Layer 2 = 2D-only overlays (tinted clones, grid, hover, 2D ghost preview)
// Layer 3 = 3D-only overlays (textured semi-transparent ghost preview)
export const LAYER_2D_TINT = 2;
export const LAYER_3D_ONLY = 3;

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
  /**
   * Ghost preview group — holds two clones per hover:
   *   - a flat yellow ghost on layer 2 (visible only in 2D pane)
   *   - a textured semi-transparent ghost on layer 3 (visible only in 3D pane)
   */
  readonly preview = new THREE.Group();
  private readonly tintMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private ghostMaterial: THREE.MeshBasicMaterial;
  /** Cached "what does the 3D ghost of tile X look like" templates. */
  private readonly ghost3DTemplates = new Map<string, THREE.Group>();
  /** Cloned ghost materials we own and must dispose. */
  private readonly ghost3DMaterials: THREE.Material[] = [];
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

    // 2D ghost — flat yellow overlay on layer 2.
    const ghost2D = loaded.template.clone();
    ghost2D.position.set(worldX, 0, worldZ);
    ghost2D.rotation.y = yaw;
    replaceMaterialsRecursive(ghost2D, this.ghostMaterial);
    setLayerRecursive(ghost2D, LAYER_2D_TINT);
    this.preview.add(ghost2D);

    // 3D ghost — real textures, semi-transparent, on layer 3.
    const ghost3DTemplate = this.getGhost3DTemplate(tileName);
    if (ghost3DTemplate) {
      const ghost3D = ghost3DTemplate.clone();
      ghost3D.position.set(worldX, 0, worldZ);
      ghost3D.rotation.y = yaw;
      // Object3D.clone() copies layers per node, but be defensive against
      // any descendants that might somehow drop their layer assignment.
      setLayerRecursive(ghost3D, LAYER_3D_ONLY);
      this.preview.add(ghost3D);
    }
  }

  /**
   * Lazily build a "3D ghost" template for a tile: clones the loaded mesh,
   * clones each material so we can mark it transparent without disturbing
   * the placed (opaque) instances, and stamps the whole subtree onto
   * LAYER_3D_ONLY so the 2D camera ignores it.
   */
  private getGhost3DTemplate(tileName: string): THREE.Group | null {
    const cached = this.ghost3DTemplates.get(tileName);
    if (cached) return cached;
    const loaded = this.assets.tiles.get(tileName);
    if (!loaded) return null;

    const template = loaded.template.clone();
    const cloneAsGhost = (m: THREE.Material): THREE.Material => {
      const c = m.clone();
      c.transparent = true;
      c.opacity = 0.5;
      c.depthWrite = false;
      this.ghost3DMaterials.push(c);
      return c;
    };
    template.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.material = Array.isArray(obj.material)
        ? obj.material.map(cloneAsGhost)
        : cloneAsGhost(obj.material);
    });
    setLayerRecursive(template, LAYER_3D_ONLY);
    this.ghost3DTemplates.set(tileName, template);
    return template;
  }

  clearPreview(): void {
    if (this.lastPreviewKey === "") return;
    this.lastPreviewKey = "";
    clearGroup(this.preview);
  }

  dispose(): void {
    this.ghostMaterial.dispose();
    for (const mat of this.tintMaterials.values()) mat.dispose();
    for (const mat of this.ghost3DMaterials) mat.dispose();
    this.ghost3DMaterials.length = 0;
    this.ghost3DTemplates.clear();
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

    this.addOriginalAndTint(loaded.template, loaded.entry.kind, worldX, worldZ, yaw, 2);
  }

  private placeVertex(structure: PlacedVertex, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + structure.x * grid.tileSize;
    const worldZ = grid.origin + structure.z * grid.tileSize;
    const yaw = (structure.rotation & 3) * (Math.PI / 2);

    this.addOriginalAndTint(loaded.template, loaded.entry.kind, worldX, worldZ, yaw, 3);
  }

  private placeCell(structure: PlacedCell, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + (structure.x + 0.5) * grid.tileSize;
    const worldZ = grid.origin + (structure.z + 0.5) * grid.tileSize;

    this.addOriginalAndTint(loaded.template, loaded.entry.kind, worldX, worldZ, 0, 1);
  }

  private addOriginalAndTint(
    template: THREE.Group,
    kind: string,
    worldX: number,
    worldZ: number,
    yaw: number,
    tintRenderOrder: number
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
    setRenderOrderRecursive(tinted, tintRenderOrder);
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

function setRenderOrderRecursive(obj: THREE.Object3D, order: number): void {
  obj.renderOrder = order;
  for (const child of obj.children) {
    setRenderOrderRecursive(child, order);
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
