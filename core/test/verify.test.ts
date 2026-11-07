import { describe, expect, it } from "vitest";
import { createPublicClient, http, toHex } from "viem";
import { sepolia } from "viem/chains";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { jcs, CORE_FIELDS, type Core } from "../src/approval";
import { checkSignedBuildHash, createVerifier, parseApproval, statusWord, IntegrityError, type VerifierClient } from "../src/verify";
import { cidFromPointer, normalizeGateways } from "../src/ipfs";
import deployment from "../../deployments/sepolia.json";

const core: Core = {
  schemaVersion: 1, chainId: "11155111", name: "prod.ensure.eth", projectName: "ensure.eth",
  parentRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4", registry: "0x9A322BAc469a3d03185730e8eCF0035389206F8B",
  parentResource: "1", resource: "2", resolver: "0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7",
  cid: "bafybeicxywmb2dczdj55tpw7j2mh6alllmxutpblzqns5xc33refxjchh4", commit: "6d7c90225e98907462b54e5959338ab0036850ab",
  buildHash: `0x${"ab".repeat(32)}`, release: "5", approver: "0xBa3084737A99f3ccB2F384b3AE8f325CF50EfBBe",
  issuedAt: "1", validUntil: "2", previousManifest: "",
};
const envelope = (c: object, signature = `0x${"11".repeat(65)}`) => jcs({ core: c, signature });

describe("parseApproval", () => {
  it("accepts the v1 schema, including registry", () => {
    expect(Object.keys(core).sort()).toEqual([...CORE_FIELDS].sort());
    expect(parseApproval(envelope(core)).core.release).toBe("5");
  });
  it("rejects a core without registry (the field the web copy used to drop)", () => {
    const { registry: _registry, ...missing } = core;
    expect(() => parseApproval(envelope(missing))).toThrow(/unexpected schema/);
  });
  it("rejects extra fields, non-canonical JSON and malformed signatures", () => {
    expect(() => parseApproval(envelope({ ...core, extra: 1 }))).toThrow(/unexpected schema/);
    expect(() => parseApproval(JSON.stringify({ signature: `0x${"11".repeat(65)}`, core }))).toThrow(/not canonical/);
    expect(() => parseApproval(envelope(core, "0x1234"))).toThrow(/signature is malformed/);
    expect(() => parseApproval("not json")).toThrow(IntegrityError);
  });
});

describe("checkSignedBuildHash", () => {
  it("binds a directory CID to its multihash digest, not to index.html", () => {
    const dir = CID.parse(core.cid);
    const digest = toHex(dir.multihash.digest);
    expect(checkSignedBuildHash(core.cid, digest, "ff".repeat(32))).toMatch(/directory/);
    expect(() => checkSignedBuildHash(core.cid, `0x${"ff".repeat(32)}`, "ff".repeat(32))).toThrow(/multihash digest/);
  });
  it("binds a raw single-file CID to the file's SHA-256", async () => {
    const bytes = new TextEncoder().encode("<h1>release</h1>");
    const hash = await sha256.digest(bytes);
    const rawCid = CID.createV1(raw.code, hash).toString();
    const fileSha = toHex(hash.digest).slice(2);
    expect(checkSignedBuildHash(rawCid, `0x${fileSha}`, fileSha)).toMatch(/SHA-256/);
    expect(() => checkSignedBuildHash(rawCid, `0x${"00".repeat(32)}`, fileSha)).toThrow(/index.html SHA-256/);
  });
});

describe("status words and IPFS helpers", () => {
  it("never reports UNPROTECTED or UNAVAILABLE as GREEN", () => {
    expect(statusWord("MATCH")).toBe("GREEN");
    expect(statusWord("MISMATCH")).toBe("RED");
    expect(statusWord("UNAVAILABLE")).toBe("AMBER");
    expect(statusWord("UNPROTECTED")).toBe("AMBER");
  });
  it("parses pointers and de-duplicates gateways in order", () => {
    expect(cidFromPointer("ipfs://bafyabc/x")).toBe("bafyabc");
    expect(cidFromPointer("  bafyabc ")).toBe("bafyabc");
    expect(cidFromPointer("")).toBeUndefined();
    expect(normalizeGateways(["https://a/", undefined, "https://a", " https://b "])).toEqual(["https://a", "https://b"]);
  });
});

describe("createVerifier routing (fake chain)", () => {
  const block = { number: 100n, hash: `0x${"aa".repeat(32)}` as const, timestamp: 1_800_000_000n };
  const fake = (overrides: Partial<VerifierClient> = {}): VerifierClient => ({
    getChainId: async () => 11155111,
    getBlock: async () => block,
    readContract: async () => { throw new Error("no such name"); },
    ...overrides,
  });

  it("is UNAVAILABLE (never green) on the wrong chain", async () => {
    const v = createVerifier({ client: fake({ getChainId: async () => 1 }), deployment, gateways: [] });
    const r = await v.verifyProject("ensure.eth");
    expect(r.status).toBe("UNAVAILABLE");
  });

  it("routes other names to the unprotected path: no resolver means UNAVAILABLE, not MISMATCH", async () => {
    const v = createVerifier({ client: fake(), deployment, gateways: [] });
    const r = await v.verifyProject("amber-falcon-3f2a.platform.eth");
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.checks.find((c) => c.id === "resolver")?.detail).toMatch(/no resolver/);
  });
});

const live = process.env.ENSURE_LIVE === "1";
describe.skipIf(!live)("live Sepolia + IPFS (ENSURE_LIVE=1)", () => {
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com") });
  const v = createVerifier({ client, deployment, gateways: ["https://ipfs.filebase.io", "https://ipfs.io"] });

  it("preview.ensure.eth checked as an unprotected name is UNPROTECTED", async () => {
    const r = await v.verifyUnprotectedName("preview.ensure.eth");
    expect(r.status).toBe("UNPROTECTED");
  }, 120_000);

  it("ensure.eth verifies (MATCH while release approval is valid)", async () => {
    const r = await v.verifyProject("ensure.eth");
    const failed = r.checks.filter((c) => c.state === "fail" || c.state === "unavailable").map((c) => `${c.label}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(r.status).toBe("MATCH");
  }, 180_000);
});
