import { zipSync, strToU8 } from "fflate";

export type ZipEntry = {
  path: string;
  data: Uint8Array;
};

/**
 * Create a ZIP blob from a list of entries.
 */
export function createZipBlob(entries: ZipEntry[]): Blob {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.path] = entry.data;
  }

  const zipped = zipSync(files);
  return new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
}

/**
 * Trigger a browser download of a Blob.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Helper: convert a JSON-serializable object to a Uint8Array.
 */
export function jsonToBytes(obj: unknown): Uint8Array {
  return strToU8(JSON.stringify(obj, null, 2));
}
