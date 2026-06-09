/**
 * Send one or more files to a LocalSend peer over HTTP. Uses the v2
 * protocol (prepare-upload + per-file upload).
 *
 * Usage:
 *   node scripts/material-studio/send-localsend.mjs <peer-host> <file...>
 *
 * Example:
 *   node scripts/material-studio/send-localsend.mjs 100.98.41.68 /tmp/a.png /tmp/b.png
 *
 * The peer (e.g. iPhone LocalSend app) must be in the foreground;
 * iOS suspends background apps and the HTTP listener with them.
 */
import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { createHash, randomUUID } from "crypto";

const [, , peer, ...files] = process.argv;
if (!peer || files.length === 0) {
  console.error("usage: node scripts/material-studio/send-localsend.mjs <peer-host> <file...>");
  process.exit(2);
}

const PORT = 53317;
// LocalSend uses HTTPS with a self-signed cert (especially on iOS).
const URL_PREFIX = `https://${peer}:${PORT}/api/localsend/v2`;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SENDER_INFO = {
  alias: "spawner",
  version: "2.1",
  deviceModel: "linux",
  deviceType: "desktop",
  fingerprint: createHash("sha256").update("spawner-localsend-sender").digest("hex"),
  port: PORT,
  protocol: "https",
  download: false,
};

const fileRecords = files.map((p) => {
  const buf = readFileSync(p);
  const id = randomUUID();
  return {
    path: p,
    id,
    fileName: basename(p),
    size: statSync(p).size,
    fileType: p.endsWith(".png") ? "image" : "other",
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf,
  };
});

const filesPayload = {};
for (const f of fileRecords) {
  filesPayload[f.id] = {
    id: f.id,
    fileName: f.fileName,
    size: f.size,
    fileType: f.fileType,
    sha256: f.sha256,
    preview: null,
  };
}

console.log(`> POST ${URL_PREFIX}/prepare-upload (${fileRecords.length} file${fileRecords.length === 1 ? "" : "s"})`);
const prep = await fetch(`${URL_PREFIX}/prepare-upload`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ info: SENDER_INFO, files: filesPayload }),
  signal: AbortSignal.timeout(60_000),
}).catch((err) => {
  console.error(`✖ prepare-upload failed: ${err.message}`);
  console.error(`  is LocalSend open in the foreground on the peer? iOS suspends background apps.`);
  process.exit(1);
});

if (!prep.ok) {
  console.error(`✖ prepare-upload returned ${prep.status}: ${await prep.text()}`);
  if (prep.status === 403) {
    console.error(`  the peer may have rejected the request (manual decline).`);
  } else if (prep.status === 401) {
    console.error(`  the peer requires a PIN — not yet implemented in this script.`);
  }
  process.exit(1);
}

const prepBody = await prep.json();
const sessionId = prepBody.sessionId;
const tokenById = prepBody.files; // { [fileId]: token }
console.log(`> session ${sessionId}, ${Object.keys(tokenById).length} file token(s) issued`);

for (const f of fileRecords) {
  const token = tokenById[f.id];
  if (!token) {
    console.warn(`! no token for ${f.fileName} — peer may have skipped it`);
    continue;
  }
  const url = `${URL_PREFIX}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(f.id)}&token=${encodeURIComponent(token)}`;
  process.stdout.write(`> uploading ${f.fileName} (${(f.size / 1024).toFixed(1)} KB) … `);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: f.bytes,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.log(`✖ ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
  } else {
    console.log(`✔`);
  }
}

console.log(`done.`);
