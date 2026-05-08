import * as THREE from "three";
import type { GridConfig, MapEditorState, PlacedEdge, PlacedCell, PlacedVertex } from "./editor-state";
import type { TilesetAssets } from "./tileset-loader";

// Layer 0 = default: placed structures with real materials, both cameras see them
// Layer 2 = 2D-only overlays (grid, hover, 2D ghost preview)
// Layer 3 = 3D-only overlays (textured semi-transparent ghost preview)
export const LAYER_2D_TINT = 2;
export const LAYER_3D_ONLY = 3;

export class SceneBuilder {
  readonly root = new THREE.Group();
  /**
   * Ghost preview group — holds two clones per hover:
   *   - a flat yellow ghost on layer 2 (visible only in 2D pane)
   *   - a textured semi-transparent ghost on layer 3 (visible only in 3D pane)
   */
  readonly preview = new THREE.Group();
  readonly selectionHighlight = new THREE.Group();
  private ghostMaterial: THREE.MeshBasicMaterial;
  private selectionMaterial: THREE.MeshBasicMaterial;
  private edgeOutlineMaterial: THREE.MeshBasicMaterial;
  private edgeOutlineGeometry: THREE.PlaneGeometry;
  private directionArrowMaterial: THREE.MeshBasicMaterial;
  private directionArrowGeometry: THREE.BufferGeometry;
  private tileSize: number;
  /** Cached "what does the 3D ghost of tile X look like" templates. */
  private readonly ghost3DTemplates = new Map<string, THREE.Group>();
  /** Cloned ghost materials we own and must dispose. */
  private readonly ghost3DMaterials: THREE.Material[] = [];
  private lastRevision = -1;
  private lastPreviewKey = "";

  constructor(private readonly assets: TilesetAssets, tileSize: number) {
    this.tileSize = tileSize;
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcc44,
      transparent: true,
      opacity: 0.4,
      depthTest: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    this.selectionMaterial = new THREE.MeshBasicMaterial({
      color: 0x44aaff,
      transparent: true,
      opacity: 0.35,
      depthTest: false
    });
    // Outline for wall tiles in 2D view
    this.edgeOutlineMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthTest: false,
      transparent: true,
      opacity: 0.6
    });
    // Wall footprint: tileSize long, 0.25*tileSize deep; add border
    const outlineBorder = tileSize * 0.04;
    this.edgeOutlineGeometry = new THREE.PlaneGeometry(
      tileSize + outlineBorder * 2,
      tileSize * 0.25 + outlineBorder * 2
    );
    this.edgeOutlineGeometry.rotateX(-Math.PI / 2);
    this.directionArrowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4444,
      depthTest: false,
      transparent: true,
      opacity: 0.8
    });
    // Small triangle pointing in -Z direction (the "outside" face)
    const s = 0.15;
    const verts = new Float32Array([
      0, 0, -s * 2,
      -s, 0, 0,
      s, 0, 0
    ]);
    this.directionArrowGeometry = new THREE.BufferGeometry();
    this.directionArrowGeometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
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

  /** Show a ghost preview of the given tile at a world position with rotation.
   *  When showDirection is true, a small red arrow shows the "outside" (-X) face. */
  setPreview(tileName: string | null, worldX: number, worldZ: number, yaw: number, showDirection = false): void {
    const key = tileName ? `${tileName}:${worldX.toFixed(3)}:${worldZ.toFixed(3)}:${yaw.toFixed(3)}:${showDirection}` : "";
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

    // Direction arrow on layer 2 — points toward the "outside" face (-X in local space)
    if (showDirection) {
      const arrow = new THREE.Mesh(this.directionArrowGeometry, this.directionArrowMaterial);
      arrow.position.set(worldX, 0.01, worldZ);
      arrow.rotation.y = yaw;
      arrow.renderOrder = 10;
      arrow.layers.set(LAYER_2D_TINT);
      this.preview.add(arrow);
    }

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

  /** Show a blue highlight overlay on a selected tile (2D only). Pass null to clear. */
  setSelection(
    kind: "edge" | "cell" | "vertex" | null,
    worldX = 0,
    worldZ = 0,
    yaw = 0
  ): void {
    clearGroup(this.selectionHighlight);
    if (!kind) return;

    let w: number, h: number;
    if (kind === "cell") {
      w = this.tileSize; h = this.tileSize;
    } else if (kind === "edge") {
      w = this.tileSize * 1.05; h = this.tileSize * 0.3;
    } else {
      w = this.tileSize * 0.3; h = this.tileSize * 0.3;
    }

    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.selectionMaterial);
    mesh.position.set(worldX, 0.002, worldZ);
    mesh.rotation.y = yaw;
    mesh.renderOrder = 5;
    mesh.layers.set(LAYER_2D_TINT);
    this.selectionHighlight.add(mesh);

    if (kind === "edge") {
      const arrow = new THREE.Mesh(this.directionArrowGeometry, this.directionArrowMaterial);
      arrow.position.set(worldX, 0.01, worldZ);
      arrow.rotation.y = yaw;
      arrow.renderOrder = 10;
      arrow.layers.set(LAYER_2D_TINT);
      this.selectionHighlight.add(arrow);
    }
  }

  dispose(): void {
    this.ghostMaterial.dispose();
    this.selectionMaterial.dispose();
    this.edgeOutlineMaterial.dispose();
    this.edgeOutlineGeometry.dispose();
    this.directionArrowMaterial.dispose();
    this.directionArrowGeometry.dispose();
    for (const mat of this.ghost3DMaterials) mat.dispose();
    this.ghost3DMaterials.length = 0;
    this.ghost3DTemplates.clear();
    clearGroup(this.root);
    clearGroup(this.preview);
    clearGroup(this.selectionHighlight);
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
    const yaw = (isVertical ? Math.PI / 2 : 0) + (structure.flipped ? Math.PI : 0);

    // 2D outline on layer 2 — dark border behind the wall mesh
    const outline = new THREE.Mesh(this.edgeOutlineGeometry, this.edgeOutlineMaterial);
    outline.position.set(worldX, 0.001, worldZ);
    outline.rotation.y = yaw;
    outline.renderOrder = -1;
    outline.layers.set(LAYER_2D_TINT);
    this.root.add(outline);

    this.placeMesh(loaded.template, worldX, worldZ, yaw);
  }

  private placeVertex(structure: PlacedVertex, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + structure.x * grid.tileSize;
    const worldZ = grid.origin + structure.z * grid.tileSize;
    const yaw = (structure.rotation & 3) * (Math.PI / 2);

    this.placeMesh(loaded.template, worldX, worldZ, yaw);
  }

  private placeCell(structure: PlacedCell, grid: GridConfig): void {
    const loaded = this.assets.tiles.get(structure.tileName);
    if (!loaded) return;

    const worldX = grid.origin + (structure.x + 0.5) * grid.tileSize;
    const worldZ = grid.origin + (structure.z + 0.5) * grid.tileSize;

    this.placeMesh(loaded.template, worldX, worldZ, 0);
  }

  private placeMesh(
    template: THREE.Group,
    worldX: number,
    worldZ: number,
    yaw: number
  ): void {
    // Original mesh on layer 0 — both cameras see it with real materials
    const original = template.clone();
    original.position.set(worldX, 0, worldZ);
    original.rotation.y = yaw;
    this.root.add(original);
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
