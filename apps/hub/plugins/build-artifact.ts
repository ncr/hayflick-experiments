/**
 * Server-side bake: open a base mesh GLB, replace per-role TEXCOORD_0 with
 * the new UV buffer (from the UV-template repack), apply the per-role PBR
 * textures (or leave the synthetic-glass material untouched), and write
 * out an `artifact.glb`.
 *
 * Replaces the Blender-driven `scripts/blockstudio/bake-textured-mesh.py`.
 * No shell-out — pure @gltf-transform/core.
 */

import * as fs from "node:fs";
import { Accessor, NodeIO, type Material } from "@gltf-transform/core";
import { KHRMaterialsIOR, KHRMaterialsTransmission } from "@gltf-transform/extensions";

export type BakePbrRole = {
  kind: "pbr";
  /** Path to baseColor PNG already written to disk by the bake handler. */
  baseColorPath: string;
  normalPath: string;
  armPath: string;
  /** New UV attribute (length = vertexCount * 2). */
  newUvBuffer: Float32Array;
  /** glTF material name to find in the GLB (e.g. "blockstudio_wall"). */
  materialName: string;
  roughnessFactor: number;
  metallicFactor: number;
};

export type BakeSyntheticRole = {
  kind: "synthetic";
  /** Currently the only kind. */
  preset: "glass";
  /** glTF material name to overwrite with synthetic glass. */
  materialName: string;
};

export type BakeRole = BakePbrRole | BakeSyntheticRole;

export type BuildArtifactInput = {
  baseMeshPath: string;
  outputPath: string;
  /** Role key → bake spec. Order doesn't matter. */
  roles: Record<string, BakeRole>;
};

export async function buildArtifact(input: BuildArtifactInput): Promise<void> {
  const io = new NodeIO();
  const doc = await io.read(input.baseMeshPath);
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();

  const transmissionExt = doc.createExtension(KHRMaterialsTransmission);
  const iorExt = doc.createExtension(KHRMaterialsIOR);

  const byMaterialName = new Map<string, BakeRole>();
  for (const role of Object.values(input.roles)) {
    byMaterialName.set(role.materialName, role);
  }

  const textureCache = new Map<string, ReturnType<typeof doc.createTexture>>();
  const loadTexture = (path: string, label: string) => {
    const cached = textureCache.get(path);
    if (cached) return cached;
    const bytes = fs.readFileSync(path);
    const tex = doc
      .createTexture(label)
      .setImage(new Uint8Array(bytes))
      .setMimeType("image/png");
    textureCache.set(path, tex);
    return tex;
  };

  const seenMaterials = new Set<string>();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      const role = byMaterialName.get(mat.getName());
      if (!role) continue;

      if (role.kind === "synthetic") {
        if (!seenMaterials.has(mat.getName())) {
          seenMaterials.add(mat.getName());
          applySyntheticGlass(mat, transmissionExt, iorExt);
        }
        continue;
      }

      const oldUv = prim.getAttribute("TEXCOORD_0");
      const vertexCount = oldUv ? oldUv.getCount() : 0;
      if (vertexCount * 2 !== role.newUvBuffer.length) {
        throw new Error(
          `Vertex count mismatch on material "${mat.getName()}": primitive has ${vertexCount} vertices but newUvBuffer is ${role.newUvBuffer.length / 2}`
        );
      }

      const uvArray = new Float32Array(role.newUvBuffer.length);
      uvArray.set(role.newUvBuffer);
      const newAccessor = doc
        .createAccessor(`${mat.getName()}_uv`)
        .setType(Accessor.Type.VEC2)
        .setArray(uvArray)
        .setBuffer(buffer);
      prim.setAttribute("TEXCOORD_0", newAccessor);

      if (!seenMaterials.has(mat.getName())) {
        seenMaterials.add(mat.getName());
        const baseColorTex = loadTexture(role.baseColorPath, `${mat.getName()}_baseColor`);
        const normalTex = loadTexture(role.normalPath, `${mat.getName()}_normal`);
        const armTex = loadTexture(role.armPath, `${mat.getName()}_arm`);

        mat
          .setBaseColorTexture(baseColorTex)
          .setNormalTexture(normalTex)
          .setMetallicRoughnessTexture(armTex)
          .setOcclusionTexture(armTex)
          .setRoughnessFactor(role.roughnessFactor)
          .setMetallicFactor(role.metallicFactor);
      }
    }
  }

  await io.write(input.outputPath, doc);
}

/**
 * Mirror the Blender pipeline's synthetic glass: tinted, low-roughness,
 * full transmission, IOR 1.45, alpha 0.35 (BLEND), double-sided.
 */
function applySyntheticGlass(
  mat: Material,
  transmissionExt: KHRMaterialsTransmission,
  iorExt: KHRMaterialsIOR
): void {
  // Slight cool tint, alpha=0.35 to match the previous Principled BSDF.
  mat
    .setBaseColorFactor([0.72, 0.82, 0.92, 0.35])
    .setRoughnessFactor(0.05)
    .setMetallicFactor(0.0)
    .setAlphaMode("BLEND")
    .setDoubleSided(true);

  const transmission = transmissionExt.createTransmission().setTransmissionFactor(1.0);
  mat.setExtension("KHR_materials_transmission", transmission);

  const ior = iorExt.createIOR().setIOR(1.45);
  mat.setExtension("KHR_materials_ior", ior);
}
