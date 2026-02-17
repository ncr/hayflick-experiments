import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import type {
  BoxColliderSpec,
  ColliderVariantsSpec,
  CompoundColliderSpec,
  ConvexHullColliderSpec
} from "./collider-mesh";

export type ColliderPreviewMode =
  | "box"
  | "convex-hull"
  | "compound-boxes"
  | "all";

const PREVIEW_COLORS = {
  box: 0x31d7ff,
  "convex-hull": 0xffb347,
  "compound-boxes": 0x8cff93
} as const;

function wireframeMaterial(color: number, opacity = 0.42): THREE.Material {
  return new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    toneMapped: false
  });
}

function buildBoxPreview(
  spec: BoxColliderSpec,
  color: number
): THREE.Object3D {
  const geometry = new THREE.BoxGeometry(
    spec.halfExtents[0] * 2,
    spec.halfExtents[1] * 2,
    spec.halfExtents[2] * 2
  );
  const mesh = new THREE.Mesh(geometry, wireframeMaterial(color));
  mesh.position.set(spec.position[0], spec.position[1], spec.position[2]);
  mesh.name = "collider-preview-box";
  mesh.renderOrder = 1000;
  return mesh;
}

function buildConvexHullPreview(
  spec: ConvexHullColliderSpec,
  color: number
): THREE.Object3D {
  const points = spec.points.map(
    ([x, y, z]) => new THREE.Vector3(x, y, z)
  );
  if (points.length < 4) {
    return new THREE.Group();
  }

  const group = new THREE.Group();
  group.position.set(-spec.rootOffset[0], -spec.rootOffset[1], -spec.rootOffset[2]);

  const geometry = new ConvexGeometry(points);
  const mesh = new THREE.Mesh(geometry, wireframeMaterial(color, 0.38));
  mesh.name = "collider-preview-convex-hull";
  mesh.renderOrder = 1000;
  group.add(mesh);

  const pointsGeometry = new THREE.BufferGeometry().setFromPoints(points);
  const pointsMaterial = new THREE.PointsMaterial({
    color,
    size: 0.018,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false
  });
  const pointsMesh = new THREE.Points(pointsGeometry, pointsMaterial);
  pointsMesh.name = "collider-preview-convex-points";
  pointsMesh.renderOrder = 1001;
  group.add(pointsMesh);

  return group;
}

function buildCompoundPreview(
  spec: CompoundColliderSpec,
  color: number
): THREE.Object3D {
  const group = new THREE.Group();
  group.name = "collider-preview-compound";
  for (const [index, part] of spec.parts.entries()) {
    const geometry = new THREE.BoxGeometry(
      part.halfExtents[0] * 2,
      part.halfExtents[1] * 2,
      part.halfExtents[2] * 2
    );
    const mesh = new THREE.Mesh(geometry, wireframeMaterial(color, 0.4));
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    mesh.name = `collider-preview-compound-part-${index + 1}`;
    mesh.renderOrder = 1000;
    group.add(mesh);
  }
  return group;
}

export function createColliderVariantsPreview(
  variants: ColliderVariantsSpec,
  mode: ColliderPreviewMode
): THREE.Object3D {
  if (mode === "all") {
    const group = new THREE.Group();
    group.name = "collider-preview-all";
    group.add(buildBoxPreview(variants.box, PREVIEW_COLORS.box));
    group.add(
      buildConvexHullPreview(variants.convexHull, PREVIEW_COLORS["convex-hull"])
    );
    group.add(
      buildCompoundPreview(
        variants.compoundBoxes,
        PREVIEW_COLORS["compound-boxes"]
      )
    );
    return group;
  }

  if (mode === "box") {
    return buildBoxPreview(variants.box, PREVIEW_COLORS.box);
  }
  if (mode === "convex-hull") {
    return buildConvexHullPreview(
      variants.convexHull,
      PREVIEW_COLORS["convex-hull"]
    );
  }
  return buildCompoundPreview(
    variants.compoundBoxes,
    PREVIEW_COLORS["compound-boxes"]
  );
}
