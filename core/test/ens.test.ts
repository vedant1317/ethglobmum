import { describe, expect, it } from "vitest";
import { RESOLVER_ROLES, REGISTRY_ROLES, decodeContenthash, dnsEncode, encodeContenthash, sameCid, withAdmin } from "../src/ens";

describe("contenthash", () => {
  const hex = "0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
  it("matches the ENSIP-7 test vector", () => {
    expect(encodeContenthash("QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4")).toBe(hex);
  });
  it("decodes to the same content", () => {
    expect(sameCid(decodeContenthash(hex), "QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4")).toBe(true);
  });
  it("rejects non-IPFS values", () => {
    expect(() => decodeContenthash("0xe40101fa011b20d1de")).toThrow(/ipfs/);
  });
});

describe("names and roles", () => {
  it("DNS-encodes names", () => expect(dnsEncode("prod.a.eth")).toBe("0x0470726f640161036574680" + "0"));
  it("role values match contracts-v2", () => {
    expect(REGISTRY_ROLES.REGISTRAR).toBe(1n);
    expect(REGISTRY_ROLES.SET_RESOLVER).toBe(1n << 24n);
    expect(REGISTRY_ROLES.UPGRADE).toBe(1n << 124n);
    expect(RESOLVER_ROLES.SET_CONTENTHASH).toBe(1n << 8n);
    expect(RESOLVER_ROLES.SET_TEXT).toBe(1n << 4n);
    expect(RESOLVER_ROLES.LINK).toBe(1n << 28n);
  });
  it("admin role sits 128 bits up", () => expect(withAdmin(1n << 8n)).toBe((1n << 8n) | (1n << 136n)));
});
