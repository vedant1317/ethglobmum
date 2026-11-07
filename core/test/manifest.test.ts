import { describe, expect, it } from "vitest";
import { buildManifest, canonicalize, checkPath, commitDigest, hashFiles, manifestBytes, manifestDigest, mimeFor, parseManifest } from "../src/manifest";

const sha = "a".repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);
const base = { repositoryId: "1", repositoryUrl: "u", commitSha: sha, workflowRunUrl: "r", siteCid: "c", buildTools: { node: "v24" } };

describe("canonicalize", () => {
  it("sorts keys recursively and has no whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [2, { z: "é", y: 1 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":1,"z":"é"}]},"b":1}');
  });
  it("gives identical output regardless of key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1, null, undefined, true])("rejects %s", (v) => {
    expect(() => canonicalize(v)).toThrow();
  });
});

describe("paths", () => {
  it.each(["", "/a", "a/../b", "./a", "a//b", "a\\b", "a/", "..", "café.txt"])("rejects %j", (p) => {
    expect(() => checkPath(p)).toThrow();
  });
  it("accepts normal paths", () => expect(() => checkPath("assets/app-1.js")).not.toThrow());
});

describe("manifest", () => {
  const files = hashFiles([{ path: "b.txt", bytes: enc("b") }, { path: "a/index.html", bytes: enc("<p>") }]);

  it("hashes and sorts files", () => {
    expect(files.map((f) => f.path)).toEqual(["a/index.html", "b.txt"]);
    expect(files[1]).toEqual({ path: "b.txt", size: 1, mime: "text/plain", sha256: "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d" });
  });
  it("same input gives the same bytes and digest", () => {
    const a = manifestBytes(buildManifest({ ...base, files }));
    const b = manifestBytes(buildManifest({ ...base, files: [...files].reverse() }));
    expect(Buffer.compare(a, b)).toBe(0);
    expect(manifestDigest(a)).toBe(manifestDigest(b));
  });
  it("a one-byte change changes the digest", () => {
    const a = manifestBytes(buildManifest({ ...base, files }));
    const b = manifestBytes(buildManifest({ ...base, siteCid: "d", files }));
    expect(manifestDigest(a)).not.toBe(manifestDigest(b));
  });
  it("rejects bad commit, duplicate paths, bad hash", () => {
    expect(() => buildManifest({ ...base, commitSha: "abc", files })).toThrow();
    expect(() => buildManifest({ ...base, files: [files[0], files[0]] })).toThrow(/duplicate/);
    expect(() => buildManifest({ ...base, files: [{ ...files[0], sha256: "x" }] })).toThrow(/sha256/);
  });
  it("parseManifest round-trips, and rejects non-canonical bytes", () => {
    const m = buildManifest({ ...base, files });
    expect(parseManifest(manifestBytes(m))).toEqual(m);
    expect(() => parseManifest(enc(JSON.stringify(m, null, 2)))).toThrow(/canonical/);
    expect(() => parseManifest(enc(`${new TextDecoder().decode(manifestBytes(m))} `))).toThrow(/canonical/);
  });
  it("commit digest is stable and MIME falls back", () => {
    expect(commitDigest(sha)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mimeFor("a.unknown")).toBe("application/octet-stream");
  });
});
