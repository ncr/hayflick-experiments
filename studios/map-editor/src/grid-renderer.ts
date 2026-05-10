import * as THREE from "three";
import type { GridConfig } from "./editor-state";
import { LAYER_2D_TINT } from "./scene-builder";

const GRID_COLOR = 0x88aa99;
const GRID_OPACITY = 0.3;
const STRUCTURE_THICKNESS_FACTOR = 0.14;
const HOVER_CELL_COLOR = 0xffffff;
const HOVER_EDGE_COLOR = 0xffcc44;
const HOVER_ALPHA = 0.35;

export type HoverTarget =
  | { kind: "cell"; x: number; z: number }
  | { kind: "edge"; ax: number; az: number; bx: number; bz: number }
  | { kind: "vertex"; x: number; z: number }
  | null;

export class GridRenderer {
  readonly root = new THREE.Group();

  private readonly gridLines = new THREE.Group();
  private readonly hoverGroup = new THREE.Group();

  private lastHover: HoverTarget = null;

  private readonly hoverCellGeometry: THREE.PlaneGeometry;
  private readonly hoverCellMaterial: THREE.MeshBasicMaterial;
  private readonly hoverEdgeMaterial: THREE.MeshBasicMaterial;

  constructor(private grid: GridConfig) {
    this.root.add(this.gridLines);
    this.root.add(this.hoverGroup);

    this.hoverCellGeometry = new THREE.PlaneGeometry(grid.tileSize, grid.tileSize);
    this.hoverCellGeometry.rotateX(-Math.PI / 2);

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

  setHover(target: HoverTarget): void {
    if (hoverEqual(this.lastHover, target)) return;
    this.lastHover = target;
    this.rebuildHover();
  }

  dispose(): void {
    this.hoverCellGeometry.dispose();
    this.hoverCellMaterial.dispose();
    this.hoverEdgeMaterial.dispose();
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
    const material = new THREE.LineBasicMaterial({
      color: GRID_COLOR,
      transparent: true,
      opacity: GRID_OPACITY
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.position.y = 0.0005;
    // Grid is an editor overlay — only the 2D pane should see it.
    lines.layers.set(LAYER_2D_TINT);
    this.gridLines.add(lines);
  }

  private rebuildHover(): void {
    disposeChildren(this.hoverGroup);
    const target = this.lastHover;
    if (!target) return;

    if (target.kind === "cell") {
      const mesh = new THREE.Mesh(this.hoverCellGeometry, this.hoverCellMaterial);
      mesh.position.set(
        this.grid.origin + (target.x + 0.5) * this.grid.tileSize,
        0.003,
        this.grid.origin + (target.z + 0.5) * this.grid.tileSize
      );
      mesh.layers.set(LAYER_2D_TINT);
      this.hoverGroup.add(mesh);
    } else if (target.kind === "vertex") {
      const size = this.grid.tileSize * 0.2;
      const geo = new THREE.PlaneGeometry(size, size);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.hoverEdgeMaterial);
      mesh.position.set(
        this.grid.origin + target.x * this.grid.tileSize,
        0.003,
        this.grid.origin + target.z * this.grid.tileSize
      );
      mesh.layers.set(LAYER_2D_TINT);
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
      mesh.layers.set(LAYER_2D_TINT);
      this.hoverGroup.add(mesh);
    }
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
  if (a.kind === "vertex" && b.kind === "vertex") {
    return a.x === b.x && a.z === b.z;
  }
  return false;
}
