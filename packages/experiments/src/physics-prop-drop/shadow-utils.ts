import * as THREE from "three";

function prepareShadowMaterial(material: THREE.Material): THREE.Material {
  material.shadowSide = material.side;
  material.needsUpdate = true;
  return material;
}

export function prepareImportedObjectShadows(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }

    const geometry = object.geometry;
    if (geometry) {
      if (!geometry.getAttribute("normal")) {
        geometry.computeVertexNormals();
      } else {
        geometry.normalizeNormals();
      }
      geometry.computeBoundingSphere();
    }

    object.castShadow = true;
    object.receiveShadow = true;

    if (Array.isArray(object.material)) {
      object.material = object.material.map((entry) => prepareShadowMaterial(entry));
    } else {
      object.material = prepareShadowMaterial(object.material);
    }
  });
}
