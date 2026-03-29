import * as THREE from "three";
import {
  LEVEL_BUILDER_STRUCTURE_KIND,
  LEVEL_EDITOR_WORLD_UNIT
} from "@common/level-editor";
import type { LevelBuilderStructureSegment } from "@common/level-editor";
import type { GridConfig, MapEditorState } from "./editor-state";
import type { TilesetAssets } from "./tileset-loader";

// Layer 0 = default: grid, terrain, 3D originals (both cameras)
// Layer 2 = 2D tinted clones (only 2D camera sees these)
export const LAYER_2D_TINT = 2;

const TINT_COLORS: Record<string, number> = {
  wall: 0xd0d8e0,
  window: 0x5599cc,
  "door-closed": 0xcc7722,
  "door-open": 0xddaa44
};

export class SceneBuilder {
  readonly root = new THREE.Group();
  private readonly tintMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private lastRevision = -1;

  constructor(private readonly assets: TilesetAssets) {}

  update(state: MapEditorState): void {
    if (state.revision === this.lastRevision) return;
    this.lastRevision = state.revision;
    this.rebuild(state);
  }

  dispose(): void {
    for (const mat of this.tintMaterials.values()) mat.dispose();
    clearGroup(this.root);
  }

  private rebuild(state: MapEditorState): void {
    clearGroup(this.root);

    for (const segment of state.structures.values()) {
      this.placeStructure(segment, state.grid);
    }
  }

  private placeStructure(segment: LevelBuilderStructureSegment, grid: GridConfig): void {
    let template: THREE.Group;
    let colorKey: string;

    if (segment.kind === LEVEL_BUILDER_STRUCTURE_KIND.WALL) {
      template = this.assets.wall;
      colorKey = "wall";
    } else if (segment.kind === LEVEL_BUILDER_STRUCTURE_KIND.WINDOW) {
      template = this.assets.window;
      colorKey = "window";
    } else if (segment.kind === LEVEL_BUILDER_STRUCTURE_KIND.DOOR) {
      template = this.assets.door;
      colorKey = segment.doorState === "open" ? "door-open" : "door-closed";
    } else {
      return;
    }

    const worldX = grid.origin + ((segment.ax + segment.bx) / 2) * grid.tileSize;
    const worldZ = grid.origin + ((segment.az + segment.bz) / 2) * grid.tileSize;
    const isVertical = segment.ax === segment.bx;
    const yaw = isVertical ? Math.PI / 2 : 0;

    // 3D original on layer 0 — both cameras see it
    const original = template.clone();
    original.position.set(worldX, 0, worldZ);
    original.rotation.y = yaw;
    this.root.add(original);

    // 2D tinted clone on layer 2 — only 2D camera sees it, draws on top
    const tinted = template.clone();
    tinted.position.set(worldX, 0, worldZ);
    tinted.rotation.y = yaw;
    const tintMat = this.getTintMaterial(colorKey);
    replaceMaterialsRecursive(tinted, tintMat);
    setLayerRecursive(tinted, LAYER_2D_TINT);
    this.root.add(tinted);
  }

  private getTintMaterial(key: string): THREE.MeshBasicMaterial {
    let mat = this.tintMaterials.get(key);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: TINT_COLORS[key] ?? 0xff00ff,
        transparent: key === "door-open",
        opacity: key === "door-open" ? 0.6 : 1,
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
