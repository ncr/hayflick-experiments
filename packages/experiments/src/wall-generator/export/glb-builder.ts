import { Document } from "@gltf-transform/core";
import { KHRMaterialsUnlit, Unlit } from "@gltf-transform/extensions";
import type { MeshData } from "../model/types";

/**
 * Build a GLB ArrayBuffer from MeshData arrays and a baked PNG texture.
 */
export async function buildGlb(
  meshes: MeshData[],
  texturePng: Uint8Array,
): Promise<ArrayBuffer> {
  const doc = new Document();
  const unlitExt = doc.createExtension(KHRMaterialsUnlit);

  const buffer = doc.createBuffer();

  // Create texture from PNG
  const texture = doc.createTexture("baseColor")
    .setImage(texturePng)
    .setMimeType("image/png");

  // Create unlit material with the baked texture
  const unlit = unlitExt.createUnlit();

  const material = doc.createMaterial("wallMaterial")
    .setBaseColorTexture(texture)
    .setDoubleSided(true)
    .setExtension("KHR_materials_unlit", unlit);

  // Create scene and node
  const scene = doc.createScene();
  const node = doc.createNode("wall");
  scene.addChild(node);

  // Build mesh from all MeshData
  const mesh = doc.createMesh("wallMesh");

  for (const meshData of meshes) {
    const posAccessor = doc.createAccessor("position")
      .setType("VEC3")
      .setArray(new Float32Array(meshData.positions.buffer.slice(0)) as unknown as Float32Array<ArrayBuffer>)
      .setBuffer(buffer);

    const normAccessor = doc.createAccessor("normal")
      .setType("VEC3")
      .setArray(new Float32Array(meshData.normals.buffer.slice(0)) as unknown as Float32Array<ArrayBuffer>)
      .setBuffer(buffer);

    const uvAccessor = doc.createAccessor("texcoord")
      .setType("VEC2")
      .setArray(new Float32Array(meshData.uvs.buffer.slice(0)) as unknown as Float32Array<ArrayBuffer>)
      .setBuffer(buffer);

    const indexAccessor = doc.createAccessor("indices")
      .setType("SCALAR")
      .setArray(new Uint32Array(meshData.indices.buffer.slice(0)) as unknown as Uint32Array<ArrayBuffer>)
      .setBuffer(buffer);

    const primitive = doc.createPrimitive()
      .setAttribute("POSITION", posAccessor)
      .setAttribute("NORMAL", normAccessor)
      .setAttribute("TEXCOORD_0", uvAccessor)
      .setIndices(indexAccessor)
      .setMaterial(material);

    mesh.addPrimitive(primitive);
  }

  node.setMesh(mesh);

  // Serialize to GLB
  const { WebIO } = await import("@gltf-transform/core");
  const io = new WebIO().registerExtensions([KHRMaterialsUnlit]);
  const binary = await io.writeBinary(doc);
  return binary.buffer;
}
