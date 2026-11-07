import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db", () => ({ sql: {} }));
const { detectFramework, parseRepoUrl } = await import("../src/builder");
const { fallbackPlan, parsePlan } = await import("../src/bot");
const { validSignature } = await import("../src/github");
const { decrypt, encrypt } = await import("../src/auth");

describe("parseRepoUrl", () => {
  it("parses plain, .git and tree URLs", () => {
    expect(parseRepoUrl("https://github.com/o/r")).toEqual({ owner: "o", repo: "r", branch: null, subfolder: "" });
    expect(parseRepoUrl("https://github.com/o/r.git").repo).toBe("r");
    expect(parseRepoUrl("https://github.com/o/r/tree/dev/apps/web")).toEqual({ owner: "o", repo: "r", branch: "dev", subfolder: "apps/web" });
  });
  it.each(["http://github.com/o/r", "https://gitlab.com/o/r", "https://github.com/o", "https://github.com/o/r/blob/main/x", "https://github.com/o/r/tree/main/a%2F..%2Fb", "https://github.com/o/r;rm/x", "https://github.com/o/r/tree/$(x)"])("rejects %s", (u) => {
    expect(() => parseRepoUrl(u)).toThrow();
  });
});

describe("detectFramework", () => {
  it("detects each framework", () => {
    expect(detectFramework(null)).toBe("plain");
    expect(detectFramework({ dependencies: { next: "1" } })).toBe("next");
    expect(detectFramework({ devDependencies: { vite: "1" } })).toBe("vite");
    expect(detectFramework({ dependencies: { "react-scripts": "1" } })).toBe("cra");
    expect(detectFramework({})).toBe("other");
  });
});

describe("webhook signature", () => {
  const raw = Buffer.from('{"a":1}');
  const good = `sha256=${createHmac("sha256", "s").update(raw).digest("hex")}`;
  it("accepts a valid signature, and rejects others", () => {
    expect(validSignature("s", raw, good)).toBe(true);
    expect(validSignature("other", raw, good)).toBe(false);
    expect(validSignature("s", raw, "sha256=00")).toBe(false);
    expect(validSignature("s", raw, undefined)).toBe(false);
  });
});

describe("deploy plans", () => {
  const text = "please deploy https://github.com/o/r to mysite.eth";
  it("falls back to a regex", () => {
    expect(fallbackPlan(text)).toEqual({ repoUrl: "https://github.com/o/r", name: "mysite.eth" });
    expect(fallbackPlan("deploy https://github.com/o/r.")).toEqual({ repoUrl: "https://github.com/o/r", name: undefined });
    expect(fallbackPlan("hello")).toBeNull();
  });
  it("accepts valid LLM output", () => {
    expect(parsePlan('{"repoUrl":"https://github.com/o/r","name":"mysite.eth"}', text)).toEqual({ repoUrl: "https://github.com/o/r", name: "mysite.eth" });
  });
  it("treats LLM output as untrusted", () => {
    expect(parsePlan("not json", text)?.repoUrl).toBe("https://github.com/o/r");
    expect(parsePlan('{"repoUrl":"https://evil.example/x"}', text)?.repoUrl).toBe("https://github.com/o/r");
    expect(parsePlan('{"repoUrl":"https://github.com/attacker/x"}', text)?.repoUrl).toBe("https://github.com/o/r");
  });
});

describe("token encryption", () => {
  it("round-trips, and detects tampering", () => {
    process.env.SESSION_SECRET = "s";
    const blob = encrypt("hello");
    expect(decrypt(blob)).toBe("hello");
    const b = Buffer.from(blob, "base64");
    b[b.length - 1] ^= 1;
    expect(() => decrypt(b.toString("base64"))).toThrow();
  });
});
