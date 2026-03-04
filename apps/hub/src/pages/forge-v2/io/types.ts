/**
 * FsBackend — injectable filesystem abstraction.
 *
 * The production implementation wraps the REST API at /api/fs-v2.
 * Tests can use InMemoryFsBackend for fast, deterministic I/O.
 */
export interface FsBackend {
  readJson<T>(path: string): Promise<T>;
  readBinary(path: string): Promise<ArrayBuffer>;
  readText(path: string): Promise<string>;
  readFile(path: string): Promise<Response>;
  writeJson(path: string, data: unknown): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer | Blob): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  listDirs(dir: string): Promise<string[]>;
}
