import { Document, WebIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";

const io = new WebIO().registerExtensions([KHRMaterialsUnlit]);

export async function loadGlbDocument(
  data: ArrayBuffer
): Promise<Document> {
  return io.readBinary(new Uint8Array(data));
}

export async function exportGlb(doc: Document): Promise<ArrayBuffer> {
  const binary = await io.writeBinary(doc);
  return binary.buffer;
}

export async function reexportGlb(
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  const doc = await loadGlbDocument(data);
  return exportGlb(doc);
}
