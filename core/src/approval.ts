// v1 owner release approval: canonical JSON core + EIP-712 signature (docs/OWNER_PROMOTE.md).
// Shared by the verifier (core/src/verify.ts), the web apps and tools/ensure-sepolia.
import canonicalizeModule from "canonicalize";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { keccak256, toBytes, hashTypedData, type Address, type Hex } from "viem";

const canonicalize = canonicalizeModule as unknown as (input: unknown) => string | undefined;
export const jcs = (x: unknown): string => { const s = canonicalize(x); if (s === undefined) throw new Error("Not canonical JSON"); return s; };

export interface Core {
  schemaVersion: 1; chainId: string; name: string; projectName: string;
  parentRegistry: Address; registry: Address; parentResource: string; resource: string; resolver: Address;
  cid: string; commit: string; buildHash: Hex; release: string; approver: Address;
  issuedAt: string; validUntil: string; previousManifest: string;
}
export interface Envelope { core: Core; signature: Hex }
export interface Expected {
  chainId: number; name: string; projectName: string; parentRegistry: Address; registry: Address;
  parentResource: string; resource: string; resolver: Address; owner: Address; minRelease: string;
}

/** Field set of a v1 signed core, sorted. Anything else is an unexpected schema. */
export const CORE_FIELDS = [
  "approver", "buildHash", "chainId", "cid", "commit", "issuedAt", "name", "parentRegistry", "parentResource",
  "previousManifest", "projectName", "registry", "release", "resolver", "resource", "schemaVersion", "validUntil",
] as const;

export const types = { ReleaseApproval: [{ name: "coreHash", type: "bytes32" }] } as const;
export const domain = (chainId: number) => ({ name: "ENSure", version: "1", chainId });
export const coreHash = (core: Core): Hex => keccak256(toBytes(jcs(core)));
export const typedApproval = (core: Core) => ({ domain: domain(Number(core.chainId)), types, primaryType: "ReleaseApproval" as const, message: { coreHash: coreHash(core) } });
export const approvalDigest = (core: Core) => hashTypedData(typedApproval(core));

/** Raw-codec SHA-256 CIDv1 of exact bytes: the commitment ensure.manifest / ensure.release hold for the approval. */
export const bytesCid = async (bytes: Uint8Array) => CID.createV1(raw.code, await sha256.digest(bytes)).toString();
