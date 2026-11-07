// Canonical release manifest. Browser-safe: no fs.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { keccak256, toBytes, type Hex } from "viem";

export type FileEntry = { path: string; size: number; mime: string; sha256: string };
export type Manifest = {
  schemaVersion: 1;
  repositoryId: string;
  repositoryUrl: string;
  commitSha: string;
  workflowRunUrl: string;
  siteCid: string;
  buildTools: Record<string, string>;
  files: FileEntry[];
};

const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  json: "application/json", map: "application/json", txt: "text/plain", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
  wasm: "application/wasm", pdf: "application/pdf", webmanifest: "application/manifest+json",
};

export const mimeFor = (path: string) =>
  MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export function checkPath(path: string): void {
  const bad =
    !path || path.startsWith("/") || path.includes("\\") || path.normalize("NFC") !== path ||
    path.split("/").some((s) => s === "" || s === "." || s === "..");
  if (bad) throw new Error(`bad path: ${JSON.stringify(path)}`);
}

export function canonicalize(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("bad number");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  throw new Error("bad value");
}

export function hashFiles(files: { path: string; bytes: Uint8Array }[]): FileEntry[] {
  return files
    .map(({ path, bytes }) => {
      checkPath(path);
      return { path, size: bytes.length, mime: mimeFor(path), sha256: bytesToHex(sha256(bytes)) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function buildManifest(m: Omit<Manifest, "schemaVersion">): Manifest {
  if (!/^[0-9a-f]{40}$/.test(m.commitSha)) throw new Error("commitSha must be 40 lowercase hex");
  const seen = new Set<string>();
  for (const f of m.files) {
    checkPath(f.path);
    if (seen.has(f.path)) throw new Error(`duplicate path: ${f.path}`);
    seen.add(f.path);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad sha256: ${f.path}`);
  }
  return { schemaVersion: 1, ...m, files: [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

export const manifestBytes = (m: Manifest) => new TextEncoder().encode(canonicalize(m));
export const manifestDigest = (b: Uint8Array): Hex => keccak256(b);
export const commitDigest = (sha: string): Hex => keccak256(toBytes(sha));

/** Parses bytes and rejects anything that isn't exactly canonical. */
export function parseManifest(bytes: Uint8Array): Manifest {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const m = JSON.parse(text);
  if (canonicalize(m) !== text) throw new Error("manifest is not canonical");
  return m as Manifest;
}
