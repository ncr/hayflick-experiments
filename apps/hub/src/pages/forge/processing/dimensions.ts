import * as THREE from "three";

export interface BBox {
  width: number;
  height: number;
  depth: number;
  center: THREE.Vector3;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export function computeBBox(object: THREE.Object3D): BBox {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    width: size.x,
    height: size.y,
    depth: size.z,
    center,
    min: box.min.clone(),
    max: box.max.clone(),
  };
}

export type ScaleMode = "height" | "width" | "max" | "manual";

export function computeScaleForTarget(
  bbox: BBox,
  mode: ScaleMode,
  targetValue: number
): number {
  switch (mode) {
    case "height":
      return bbox.height > 0 ? targetValue / bbox.height : 1;
    case "width":
      return bbox.width > 0 ? targetValue / bbox.width : 1;
    case "max": {
      const maxDim = Math.max(bbox.width, bbox.height, bbox.depth);
      return maxDim > 0 ? targetValue / maxDim : 1;
    }
    case "manual":
      return targetValue;
  }
}

export function applyScale(object: THREE.Object3D, scale: number): void {
  object.scale.set(scale, scale, scale);
  object.updateMatrixWorld(true);
}

export type PivotPreset = "bottom-center" | "center" | "bottom-front-center";

export function computePivotOffset(
  bbox: BBox,
  preset: PivotPreset
): THREE.Vector3 {
  switch (preset) {
    case "bottom-center":
      return new THREE.Vector3(-bbox.center.x, -bbox.min.y, -bbox.center.z);
    case "center":
      return new THREE.Vector3(-bbox.center.x, -bbox.center.y, -bbox.center.z);
    case "bottom-front-center":
      return new THREE.Vector3(-bbox.center.x, -bbox.min.y, -bbox.max.z);
  }
}

export function applyPivotOffset(
  object: THREE.Object3D,
  offset: THREE.Vector3
): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.geometry.translate(offset.x, offset.y, offset.z);
    }
  });
}

export function createBBoxHelper(bbox: BBox): THREE.Box3Helper {
  const box = new THREE.Box3(bbox.min, bbox.max);
  const helper = new THREE.Box3Helper(box, new THREE.Color(0x00ff88));
  return helper;
}

export function createDimensionLabels(
  bbox: BBox
): THREE.Group {
  const group = new THREE.Group();
  group.name = "dimension-labels";

  // We create simple line markers for each dimension
  const material = new THREE.LineBasicMaterial({ color: 0x00ff88 });

  // Width line (X axis) along the bottom
  const widthGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z + 0.05),
    new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z + 0.05),
  ]);
  group.add(new THREE.Line(widthGeo, material));

  // Height line (Y axis) on the right
  const heightGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(bbox.max.x + 0.05, bbox.min.y, bbox.max.z),
    new THREE.Vector3(bbox.max.x + 0.05, bbox.max.y, bbox.max.z),
  ]);
  group.add(new THREE.Line(heightGeo, material));

  // Depth line (Z axis) along the bottom
  const depthGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(bbox.max.x + 0.05, bbox.min.y, bbox.min.z),
    new THREE.Vector3(bbox.max.x + 0.05, bbox.min.y, bbox.max.z),
  ]);
  group.add(new THREE.Line(depthGeo, material));

  return group;
}
