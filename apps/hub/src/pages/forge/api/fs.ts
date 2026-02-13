export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export async function readFile(filePath: string): Promise<Response> {
  const res = await fetch(
    `/api/fs/read?path=${encodeURIComponent(filePath)}`
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Not found: ${filePath}`);
    throw new Error(`FS read failed: ${res.statusText}`);
  }
  return res;
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const res = await readFile(filePath);
  const data = await res.json();
  return (data.content ? JSON.parse(data.content) : data) as T;
}

export async function readText(filePath: string): Promise<string> {
  const res = await readFile(filePath);
  const data = await res.json();
  return data.content as string;
}

export async function readBinary(filePath: string): Promise<ArrayBuffer> {
  const res = await readFile(filePath);
  return res.arrayBuffer();
}

export async function writeJson(
  filePath: string,
  data: unknown
): Promise<void> {
  const res = await fetch(
    `/api/fs/write?path=${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) throw new Error(`FS write failed: ${res.statusText}`);
}

export async function writeText(
  filePath: string,
  text: string
): Promise<void> {
  const res = await fetch(
    `/api/fs/write?path=${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(text),
    }
  );
  if (!res.ok) throw new Error(`FS write failed: ${res.statusText}`);
}

export async function writeBinary(
  filePath: string,
  data: ArrayBuffer | Blob
): Promise<void> {
  const res = await fetch(
    `/api/fs/write?path=${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
    }
  );
  if (!res.ok) throw new Error(`FS write failed: ${res.statusText}`);
}

export async function listDirs(dir: string): Promise<string[]> {
  const res = await fetch(
    `/api/fs/list?dir=${encodeURIComponent(dir)}`
  );
  if (!res.ok) throw new Error(`FS list failed: ${res.statusText}`);
  return res.json();
}

export async function listEntries(dirPath: string): Promise<DirEntry[]> {
  const res = await readFile(dirPath);
  return res.json();
}
