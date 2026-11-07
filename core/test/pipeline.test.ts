import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOutput } from "../src/pipeline";

async function site(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), "ensure-out-"));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(d, p, ".."), { recursive: true });
    await writeFile(join(d, p), c);
  }
  return d;
}

describe("readOutput", () => {
  it("reads nested files", async () => {
    const files = await readOutput(await site({ "index.html": "x", "assets/a.js": "y" }));
    expect(files.map((f) => f.path).sort()).toEqual(["assets/a.js", "index.html"]);
  });
  it("rejects empty output, and output with no index.html", async () => {
    await expect(readOutput(await site({}))).rejects.toThrow(/empty/);
    await expect(readOutput(await site({ "a.js": "x" }))).rejects.toThrow(/index.html/);
  });
  it("rejects symlinks", async () => {
    const d = await site({ "index.html": "x" });
    await symlink("/etc/passwd", join(d, "leak"));
    await expect(readOutput(d)).rejects.toThrow(/symlink/);
  });
  it.each([".env", ".env.local", "a/.env", "x.pem", "x.key", ".npmrc", ".git/config", "id_rsa"])("rejects %s", async (name) => {
    await expect(readOutput(await site({ "index.html": "x", [name]: "y" }))).rejects.toThrow(/refusing/);
  });
  it.each(["-----BEGIN RSA PRIVATE KEY-----", `ghp_${"a".repeat(36)}`, "AKIAABCDEFGHIJKLMNOP"])("rejects secret content %s", async (secret) => {
    await expect(readOutput(await site({ "index.html": "x", "app.js": `const k="${secret}"` }))).rejects.toThrow(/secret/);
  });
  it("allows ordinary hashes in bundles", async () => {
    await expect(readOutput(await site({ "index.html": `0x${"ab".repeat(32)}` }))).resolves.toHaveLength(1);
  });
});
