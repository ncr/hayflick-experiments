import * as THREE from "three";
import type { LevelBuilderGroundBase } from "@common/level-editor";
import type { GridConfig, MapEditorState } from "./editor-state";

const GROUND_COLORS: Record<LevelBuilderGroundBase, number> = {
  grass: 0x4a7a3a,
  floor: 0x9e9484,
  road: 0x4a5560,
  sidewalk: 0x9ea3a8,
  building: 0x8090a0
};

const GRID_COLOR = 0x445566;
const DEFAULT_GROUND_ALPHA = 0.35;
const STRUCTURE_THICKNESS_FACTOR = 0.14;
const HOVER_CELL_COLOR = 0xffffff;
const HOVER_EDGE_COLOR = 0xffcc44;
const HOVER_ALPHA = 0.35;

export type HoverTarget =
  | { kind: "cell"; x: number; z: number }
  | { kind: "edge"; ax: number; az: number; bx: number; bz: number }
  | null;

export class GridRenderer {
  readonly root = new THREE.Group();

  private readonly gridLines = new THREE.Group();
  private readonly terrainGroup = new THREE.Group();
  private readonly hoverGroup = new THREE.Group();
  private readonly defaultGroundMesh: THREE.Mesh;

  private lastRevision = -1;
  private lastHover: HoverTarget = null;

  private cellGeometry: THREE.PlaneGeometry | null = null;
  private cellMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private hoverCellMaterial: THREE.MeshBasicMaterial;
  private hoverEdgeMaterial: THREE.MeshBasicMaterial;

  constructor(private grid: GridConfig) {
    this.root.add(this.gridLines);
    this.root.add(this.terrainGroup);
    this.root.add(this.hoverGroup);

    // Default ground plane covering the whole grid
    const fullSize = grid.tiles * grid.tileSize;
    const groundGeo = new THREE.PlaneGeometry(fullSize, fullSize);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshBasicMaterial({
      color: GROUND_COLORS.grass,
      transparent: true,
      opacity: DEFAULT_GROUND_ALPHA,
      depthWrite: false
    });
    this.defaultGroundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.defaultGroundMesh.position.set(
      grid.origin + fullSize / 2,
      0,
      grid.origin + fullSize / 2
    );
    this.root.add(this.defaultGroundMesh);

    this.hoverCellMaterial = new THREE.MeshBasicMaterial({
      color: HOVER_CELL_COLOR,
      transparent: true,
      opacity: HOVER_ALPHA,
      depthWrite: false
    });
    this.hoverEdgeMaterial = new THREE.MeshBasicMaterial({
      color: HOVER_EDGE_COLOR,
      transparent: true,
      opacity: HOVER_ALPHA,
      depthWrite: false
    });

    this.buildGridLines();
  }

  update(state: MapEditorState): void {
    if (state.revision === this.lastRevision) return;
    this.lastRevision = state.revision;

    // Update default ground color
    const groundMat = this.defaultGroundMesh.material as THREE.MeshBasicMaterial;
    groundMat.color.setHex(GROUND_COLORS[state.defaultGround] ?? GROUND_COLORS.grass);

    this.rebuildTerrain(state);
  }

  setHover(target: HoverTarget): void {
    if (hoverEqual(this.lastHover, target)) return;
    this.lastHover = target;
    this.rebuildHover();
  }

  dispose(): void {
    this.cellGeometry?.dispose();
    for (const mat of this.cellMaterials.values()) mat.dispose();
    this.hoverCellMaterial.dispose();
    this.hoverEdgeMaterial.dispose();
    (this.defaultGroundMesh.geometry as THREE.PlaneGeometry).dispose();
    (this.defaultGroundMesh.material as THREE.MeshBasicMaterial).dispose();
  }

  private buildGridLines(): void {
    const { tiles, tileSize, origin } = this.grid;
    const end = origin + tiles * tileSize;
    const points: number[] = [];

    for (let i = 0; i <= tiles; i++) {
      const pos = origin + i * tileSize;
      // Horizontal line
      points.push(origin, 0, pos, end, 0, pos);
      // Vertical line
      points.push(pos, 0, origin, pos, 0, end);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.5 });
    const lines = new THREE.LineSegments(geometry, material);
    lines.position.y = 0.0005;
    this.gridLines.add(lines);
  }

  private rebuildTerrain(state: MapEditorState): void {
    disposeChildren(this.terrainGroup);

    if (!this.cellGeometry) {
      this.cellGeometry = new THREE.PlaneGeometry(state.grid.tileSize, state.grid.tileSize);
      this.cellGeometry.rotateX(-Math.PI / 2);
    }

    for (const override of state.terrainOverrides.values()) {
      const mat = this.getCellMaterial(override.base);
      const mesh = new THREE.Mesh(this.cellGeometry, mat);
      mesh.position.set(
        state.grid.origin + (override.x + 0.5) * state.grid.tileSize,
        0.001,
        state.grid.origin + (override.z + 0.5) * state.grid.tileSize
      );
      this.terrainGroup.add(mesh);
    }
  }

  private rebuildHover(): void {
    disposeChildren(this.hoverGroup);
    const target = this.lastHover;
    if (!target) return;

    if (target.kind === "cell") {
      if (!this.cellGeometry) {
        this.cellGeometry = new THREE.PlaneGeometry(this.grid.tileSize, this.grid.tileSize);
        this.cellGeometry.rotateX(-Math.PI / 2);
      }
      const mesh = new THREE.Mesh(this.cellGeometry, this.hoverCellMaterial);
      mesh.position.set(
        this.grid.origin + (target.x + 0.5) * this.grid.tileSize,
        0.003,
        this.grid.origin + (target.z + 0.5) * this.grid.tileSize
      );
      this.hoverGroup.add(mesh);
    } else {
      const ax = this.grid.origin + target.ax * this.grid.tileSize;
      const az = this.grid.origin + target.az * this.grid.tileSize;
      const bx = this.grid.origin + target.bx * this.grid.tileSize;
      const bz = this.grid.origin + target.bz * this.grid.tileSize;
      const isVertical = target.ax === target.bx;
      const length = isVertical ? Math.abs(bz - az) : Math.abs(bx - ax);
      const thickness = this.grid.tileSize * STRUCTURE_THICKNESS_FACTOR;

      const geo = new THREE.PlaneGeometry(length, thickness);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.hoverEdgeMaterial);
      mesh.position.set(
        (ax + bx) / 2,
        0.003,
        (az + bz) / 2
      );
      if (isVertical) {
        mesh.rotation.y = Math.PI / 2;
      }
      this.hoverGroup.add(mesh);
    }
  }

  private getCellMaterial(base: LevelBuilderGroundBase): THREE.MeshBasicMaterial {
    let mat = this.cellMaterials.get(base);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: GROUND_COLORS[base] ?? 0xff00ff,
        depthWrite: false
      });
      this.cellMaterials.set(base, mat);
    }
    return mat;
  }

}

function disposeChildren(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    if (child instanceof THREE.Mesh) {
      // Don't dispose shared geometry/materials — only per-rebuild geometries
    }
  }
}

function hoverEqual(a: HoverTarget, b: HoverTarget): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "cell" && b.kind === "cell") {
    return a.x === b.x && a.z === b.z;
  }
  if (a.kind === "edge" && b.kind === "edge") {
    return a.ax === b.ax && a.az === b.az && a.bx === b.bx && a.bz === b.bz;
  }
  return false;
}
