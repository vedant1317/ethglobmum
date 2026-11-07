import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashDomain, keccak256, namehash, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PROMOTE_TYPES, ROLLBACK_TYPES, actionDigest, canonicalBuildPointerCid, controllerV2Abi, decodeProof, encodeProof, evaluateV2,
  isValidArtifact, releaseIdOf, v2Domain, type DecodedProof, type V2Evidence,
} from "../src/controller-v2";
import { encodeContenthash } from "../src/ens";
import { commitDigest } from "../src/manifest";

const solidity = readFileSync(fileURLToPath(new URL("../../contracts/ensure/src/ENSureReleaseController.sol", import.meta.url)), "utf8");
const typeString = (name: "Promote" | "Rollback") =>
  `${name}(${(name === "Promote" ? PROMOTE_TYPES.Promote : ROLLBACK_TYPES.Rollback).map((f) => `${f.type} ${f.name}`).join(",")})`;
const structFields = (name: string) => /struct\s+(\w+)\s*\{([^}]*)\}/g;

describe("ABI and EIP-712 types match the Solidity source", () => {
  it("Promote and Rollback type strings are the contract's typehash preimages", () => {
    expect(solidity).toContain(`"${typeString("Promote")}"`);
    expect(solidity).toContain(`"${typeString("Rollback")}"`);
  });
  it("Release and Transition struct field order matches the getters", () => {
    const structs = Object.fromEntries([...solidity.matchAll(structFields(""))].map((m) => [m[1], m[2].split(";").map((l) => l.trim().split(/\s+/).pop()).filter(Boolean)]));
    const outputs = (fn: string) => (controllerV2Abi.find((x) => x.type === "function" && x.name === fn) as any).outputs[0].components.map((c: { name: string }) => c.name);
    expect(outputs("getRelease")).toEqual(structs.Release);
    expect(outputs("getTransition")).toEqual(structs.Transition);
  });
});

// ── A complete, internally consistent v2 state, as the controller would leave it after promote #6 ──
const chainId = 11155111;
const controller = "0x00000000000000000000000000000000c0de0002" as Address;
const projectNode = namehash("ensure.eth");
const prodResolver = "0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7" as Address;
const previewResolver = "0x75b4dCA2604585c81ce4E24c9879E1aBF1514Bcf" as Address;
const contenthash = encodeContenthash("bafybeicxywmb2dczdj55tpw7j2mh6alllmxutpblzqns5xc33refxjchh4");
const buildPointer = "ipfs://bafkreihdbz27xulaxqkk7k2cbvuc2nwqtv4nd55tklyyar4faj2qauee4m";
const manifestDigest = keccak256(toBytes("canonical manifest bytes"));
const commit = commitDigest("6d7c90225e98907462b54e5959338ab0036850ab");
const previousId = `0x${"11".repeat(32)}` as Hex;
const domainSeparator = hashDomain({ domain: { ...v2Domain(chainId, controller), chainId: BigInt(chainId) }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } });

async function promoteState(signerKey = generatePrivateKey(), overrides: { deadline?: bigint; executedAt?: bigint } = {}) {
  const owner = privateKeyToAccount(signerKey);
  const struct = { contenthashHash: keccak256(contenthash), buildPointer, manifestDigest, commitDigest: commit, sequence: 6n, expectedCurrentReleaseId: previousId, nonce: 0n, deadline: overrides.deadline ?? 2_000_000_000n };
  const signature = await owner.signTypedData({ domain: v2Domain(chainId, controller), types: PROMOTE_TYPES, primaryType: "Promote", message: struct });
  const proof: DecodedProof = { action: "promote", domainSeparator, struct, signature };
  const proofHex = encodeProof(proof);
  const releaseId = releaseIdOf(projectNode, struct);
  const evidence: V2Evidence = {
    chainId, controller, projectNode, expectedProdResolver: prodResolver, expectedPreviewResolver: previewResolver,
    currentOwner: owner.address,
    prodContenthash: contenthash,
    records: { release: "6", manifest: buildPointer, build: buildPointer, approval: proofHex, controllerPointer: controller },
    state: { projectNode, productionResolver: prodResolver, previewResolver, domainSeparator, currentReleaseId: releaseId, lastSequence: 6n, paused: false },
    currentRelease: { exists: true, contenthash, buildPointer, manifestDigest, commitDigest: commit, approver: owner.address, approvedAt: 1_900_000_000n, firstSequence: 6n },
    latestTransition: { sequence: 6n, fromReleaseId: previousId, toReleaseId: releaseId, authorizer: owner.address, timestamp: overrides.executedAt ?? 1_900_000_000n, isRollback: false, actionDigest: actionDigest(chainId, controller, proof), proof: proofHex },
  };
  return { owner, struct, proof, evidence };
}

const clone = (e: V2Evidence): V2Evidence => structuredClone(e);

describe("evaluateV2", () => {
  it("accepts a consistent, owner-signed promotion", async () => {
    const { owner, evidence } = await promoteState();
    const v2 = await evaluateV2(evidence);
    expect(v2.action).toBe("promote");
    expect(v2.sequence).toBe(6n);
    expect(v2.approver).toBe(owner.address);
    expect(v2.manifestCid).toBe("bafkreihdbz27xulaxqkk7k2cbvuc2nwqtv4nd55tklyyar4faj2qauee4m");
  });

  it("accepts an owner-signed rollback to a stored release", async () => {
    const { owner, evidence } = await promoteState();
    const key = generatePrivateKey();
    const rollbackOwner = privateKeyToAccount(key);
    const target = evidence.state.currentReleaseId;
    const struct = { targetReleaseId: target, sequence: 7n, expectedCurrentReleaseId: previousId, nonce: 1n, deadline: 2_000_000_000n };
    const signature = await rollbackOwner.signTypedData({ domain: v2Domain(chainId, controller), types: ROLLBACK_TYPES, primaryType: "Rollback", message: struct });
    const proof: DecodedProof = { action: "rollback", domainSeparator, struct, signature };
    const e = clone(evidence);
    e.currentOwner = rollbackOwner.address;
    e.records.release = "7";
    e.records.approval = encodeProof(proof);
    e.state.lastSequence = 7n;
    e.latestTransition = { sequence: 7n, fromReleaseId: previousId, toReleaseId: target, authorizer: rollbackOwner.address, timestamp: 1_950_000_000n, isRollback: true, actionDigest: actionDigest(chainId, controller, proof), proof: e.records.approval as Hex };
    const v2 = await evaluateV2(e);
    expect(v2.action).toBe("rollback");
    expect(v2.approver).not.toBe(owner.address);
  });

  const cases: [string, (e: V2Evidence) => void, RegExp][] = [
    ["ensure.controller points elsewhere", (e) => { e.records.controllerPointer = "0x0000000000000000000000000000000000000bad"; }, /ensure\.controller/],
    ["v1-style records under a v2 controller", (e) => { e.records.release = "ipfs://bafkreiegr2lhz5prd7bun736mwyhvxe4x3fctxvtmgzhfxzcvcxdq54v3i"; }, /canonical decimal/],
    ["sequence with a leading zero", (e) => { e.records.release = "06"; }, /canonical decimal/],
    ["release record behind the controller", (e) => { e.records.release = "5"; }, /lastSequence/],
    ["ensure.manifest differs from ensure.build", (e) => { e.records.manifest = "ipfs://bafkreiegr2lhz5prd7bun736mwyhvxe4x3fctxvtmgzhfxzcvcxdq54v3i"; }, /ensure\.manifest differs/],
    ["non-canonical build pointer", (e) => { e.records.build = e.records.manifest = "https://ipfs.io/ipfs/bafkreihdbz27xulaxqkk7k2cbvuc2nwqtv4nd55tklyyar4faj2qauee4m"; }, /canonical ipfs/],
    ["owner wrote a different contenthash directly (drift)", (e) => { e.prodContenthash = encodeContenthash("bafkreiegr2lhz5prd7bun736mwyhvxe4x3fctxvtmgzhfxzcvcxdq54v3i"); }, /current release \(direct write or drift\)/],
    ["proof bytes differ from the stored transition", (e) => { const p = e.records.approval; e.latestTransition!.proof = `${p.slice(0, 10)}${p[10] === "0" ? "1" : "0"}${p.slice(11)}` as Hex; }, /stored in the latest transition/],
    ["upper-case hex approval", (e) => { e.records.approval = e.records.approval.toUpperCase().replace("0X", "0x"); }, /lower-case 0x hex/],
    ["controller bound to other resolvers", (e) => { e.state.productionResolver = previewResolver; }, /different prod\/preview resolvers/],
    ["wrong domain separator", (e) => { e.state.domainSeparator = `0x${"22".repeat(32)}`; }, /domainSeparator/],
    ["signer is no longer the current ENS owner", (e) => { e.currentOwner = "0x0000000000000000000000000000000000000abc"; }, /not the current ENS owner/],
    ["no recorded transition", (e) => { e.latestTransition = undefined; }, /no recorded transition/],
    ["unknown current release", (e) => { e.currentRelease.exists = false; }, /no stored release/],
  ];
  it.each(cases)("rejects: %s", async (_name, mutate, error) => {
    const { evidence } = await promoteState();
    const e = clone(evidence);
    mutate(e);
    await expect(evaluateV2(e)).rejects.toThrow(error);
  });

  it("rejects a proof whose deadline passed before execution", async () => {
    const { evidence } = await promoteState(undefined, { deadline: 1_800_000_000n, executedAt: 1_900_000_000n });
    await expect(evaluateV2(evidence)).rejects.toThrow(/deadline had passed/);
  });

  it("rejects a high-s (malleated) signature", async () => {
    const { evidence, proof } = await promoteState();
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${proof.signature.slice(66, 130)}`);
    const v = Number.parseInt(proof.signature.slice(130, 132), 16);
    const malleated = `${proof.signature.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    const e = clone(evidence);
    e.records.approval = encodeProof({ ...proof, signature: malleated });
    e.latestTransition!.proof = e.records.approval as Hex;
    await expect(evaluateV2(e)).rejects.toThrow(/low-s/);
  });
});

describe("encoding helpers", () => {
  it("round-trips proofs exactly", async () => {
    const { proof } = await promoteState();
    const decoded = decodeProof(encodeProof(proof));
    expect(decoded.action).toBe("promote");
    expect(decoded.struct).toEqual(proof.struct);
    expect(decoded.signature).toBe(proof.signature);
  });
  it("rejects v1 inline JSON and unknown proof versions", () => {
    expect(() => decodeProof('{"core":{},"signature":"0x"}')).toThrow(/lower-case 0x hex/);
    expect(() => decodeProof(`0x${"0".repeat(63)}1${"0".repeat(63)}1`)).toThrow(/version is 1/);
  });
  it("applies the contract's artifact and pointer rules", () => {
    expect(isValidArtifact(contenthash)).toBe(true);
    expect(isValidArtifact("0xe301")).toBe(false);
    expect(canonicalBuildPointerCid(buildPointer)).toBe("bafkreihdbz27xulaxqkk7k2cbvuc2nwqtv4nd55tklyyar4faj2qauee4m");
    expect(canonicalBuildPointerCid("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBeUndefined();
    expect(canonicalBuildPointerCid(`${buildPointer}/index.html`)).toBeUndefined();
  });
});
