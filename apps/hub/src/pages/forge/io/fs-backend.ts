/**
 * Production FsBackend — delegates to the REST API at /api/fs-v2.
 */
import * as fsApi from "../api/fs";
import type { FsBackend } from "./types";

export class RestFsBackend implements FsBackend {
  readJson<T>(path: string): Promise<T> {
    return fsApi.readJson<T>(path);
  }
  readBinary(path: string): Promise<ArrayBuffer> {
    return fsApi.readBinary(path);
  }
  readText(path: string): Promise<string> {
    return fsApi.readText(path);
  }
  readFile(path: string): Promise<Response> {
    return fsApi.readFile(path);
  }
  writeJson(path: string, data: unknown): Promise<void> {
    return fsApi.writeJson(path, data);
  }
  writeBinary(path: string, data: ArrayBuffer | Blob): Promise<void> {
    return fsApi.writeBinary(path, data);
  }
  writeText(path: string, text: string): Promise<void> {
    return fsApi.writeText(path, text);
  }
  listDirs(dir: string): Promise<string[]> {
    return fsApi.listDirs(dir);
  }
}

/** Singleton for production use. */
export const restFsBackend = new RestFsBackend();
