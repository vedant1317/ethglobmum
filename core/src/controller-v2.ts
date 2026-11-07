// ENSureReleaseController v2 reader (contracts/ensure/src/ENSureReleaseController.sol, docs/RELEASE_CONTROLLER.md).
// Pure functions: the verifier reads the chain, this module decides. Used only when the address book sets
// releaseController (no fallback to v1).
import {
  decodeAbiParameters, encodeAbiParameters, hashDomain, hashTypedData, keccak256, parseAbi, recoverAddress, toBytes,
  type Address, type Hex,
} from "viem";
import { CID } from "multiformats/cid";
import { IntegrityError } from "./errors";

export const controllerV2Abi = parseAbi([
  "function projectNode() view returns (bytes32)",
  "function productionResolver() view returns (address)",
  "function previewResolver() view returns (address)",
  "function domainSeparator() view returns (bytes32)",
  "function currentReleaseId() view returns (bytes32)",
  "function lastSequence() view returns (uint64)",
  "function paused() view returns (bool)",
  "function transitionCount() view returns (uint256)",
  "function getRelease(bytes32 releaseId) view returns ((bool exists, bytes contenthash, string buildPointer, bytes32 manifestDigest, bytes32 commitDigest, address approver, uint64 approvedAt, uint64 firstSequence))",
  "function getTransition(uint256 index) view returns ((uint64 sequence, bytes32 fromReleaseId, bytes32 toReleaseId, address authorizer, uint64 timestamp, bool isRollback, bytes32 actionDigest, bytes proof))",
  "event ReleasePromoted(bytes32 indexed releaseId, bytes32 indexed previousReleaseId, address indexed approver, uint64 sequence, bytes32 actionDigest)",
  "event ReleaseRolledBack(bytes32 indexed releaseId, bytes32 indexed fromReleaseId, address indexed approver, uint64 sequence, bytes32 actionDigest)",
]);

export const PROMOTE_TYPES = {
  Promote: [
    { name: "contenthashHash", type: "bytes32" },
    { name: "buildPointer", type: "string" },
    { name: "manifestDigest", type: "bytes32" },
    { name: "commitDigest", type: "bytes32" },
    { name: "sequence", type: "uint64" },
    { name: "expectedCurrentReleaseId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export const ROLLBACK_TYPES = {
  Rollback: [
    { name: "targetReleaseId", type: "bytes32" },
    { name: "sequence", type: "uint64" },
    { name: "expectedCurrentReleaseId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type PromoteV2 = { contenthashHash: Hex; buildPointer: string; manifestDigest: Hex; commitDigest: Hex; sequence: bigint; expectedCurrentReleaseId: Hex; nonce: bigint; deadline: bigint };
export type RollbackV2 = { targetReleaseId: Hex; sequence: bigint; expectedCurrentReleaseId: Hex; nonce: bigint; deadline: bigint };
export type StoredReleaseV2 = { exists: boolean; contenthash: Hex; buildPointer: string; manifestDigest: Hex; commitDigest: Hex; approver: Address; approvedAt: bigint; firstSequence: bigint };
export type TransitionV2 = { sequence: bigint; fromReleaseId: Hex; toReleaseId: Hex; authorizer: Address; timestamp: bigint; isRollback: boolean; actionDigest: Hex; proof: Hex };
export type DecodedProof =
  | { action: "promote"; domainSeparator: Hex; struct: PromoteV2; signature: Hex }
  | { action: "rollback"; domainSeparator: Hex; struct: RollbackV2; signature: Hex };

const promoteTuple = { type: "tuple", components: PROMOTE_TYPES.Promote } as const;
const rollbackTuple = { type: "tuple", components: ROLLBACK_TYPES.Rollback } as const;
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const v2Domain = (chainId: number, controller: Address) =>
  ({ name: "ENSureReleaseController", version: "2", chainId, verifyingContract: controller }) as const;

export const releaseIdOf = (projectNode: Hex, p: Pick<PromoteV2, "contenthashHash" | "buildPointer" | "manifestDigest" | "commitDigest">): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [projectNode, p.contenthashHash, keccak256(toBytes(p.buildPointer)), p.manifestDigest, p.commitDigest],
  ));

export function actionDigest(chainId: number, controller: Address, proof: DecodedProof): Hex {
  return proof.action === "promote"
    ? hashTypedData({ domain: v2Domain(chainId, controller), types: PROMOTE_TYPES, primaryType: "Promote", message: proof.struct })
    : hashTypedData({ domain: v2Domain(chainId, controller), types: ROLLBACK_TYPES, primaryType: "Rollback", message: proof.struct });
}

/** abi.encode(uint8(2), uint8(action), domainSeparator, struct, signature), exactly as the controller writes it. */
export function encodeProof(proof: DecodedProof): Hex {
  return proof.action === "promote"
    ? encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "bytes32" }, promoteTuple, { type: "bytes" }], [2, 1, proof.domainSeparator, proof.struct, proof.signature])
    : encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "bytes32" }, rollbackTuple, { type: "bytes" }], [2, 2, proof.domainSeparator, proof.struct, proof.signature]);
}

export function decodeProof(proofHex: string): DecodedProof {
  if (!/^0x(?:[0-9a-f]{2})+$/.test(proofHex)) throw new IntegrityError("ensure.approval is not lower-case 0x hex of an ABI proof");
  const hex = proofHex as Hex;
  let version: number, action: number;
  try { [version, action] = decodeAbiParameters([{ type: "uint8" }, { type: "uint8" }], `0x${hex.slice(2, 130)}`); }
  catch { throw new IntegrityError("ensure.approval proof header cannot be decoded"); }
  if (version !== 2) throw new IntegrityError(`ensure.approval proof version is ${version}, expected 2`);
  try {
    if (action === 1) {
      const [, , domainSeparator, struct, signature] = decodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "bytes32" }, promoteTuple, { type: "bytes" }], hex);
      return { action: "promote", domainSeparator, struct: struct as PromoteV2, signature };
    }
    if (action === 2) {
      const [, , domainSeparator, struct, signature] = decodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "bytes32" }, rollbackTuple, { type: "bytes" }], hex);
      return { action: "rollback", domainSeparator, struct: struct as RollbackV2, signature };
    }
  } catch { throw new IntegrityError("ensure.approval proof body cannot be decoded"); }
  throw new IntegrityError(`ensure.approval proof action is ${action}, expected 1 (promote) or 2 (rollback)`);
}

/** The contract's own artifact rule: ENSIP-7 IPFS CIDv1, raw or dag-pb, SHA2-256, exactly 38 bytes. */
export function isValidArtifact(contenthash: Hex) {
  const b = toBytes(contenthash);
  return b.length === 38 && b[0] === 0xe3 && b[1] === 0x01 && b[2] === 0x01 && (b[3] === 0x55 || b[3] === 0x70) && b[4] === 0x12 && b[5] === 0x20;
}

/** CID-only `ipfs://` pointer, raw or dag-pb CIDv1 / SHA2-256, canonical lower-case base32. */
export function canonicalBuildPointerCid(pointer: string): string | undefined {
  const match = /^ipfs:\/\/(b[a-z2-7]+)$/.exec(pointer);
  if (!match) return undefined;
  try {
    const cid = CID.parse(match[1]);
    if (cid.version !== 1 || (cid.code !== 0x55 && cid.code !== 0x70) || cid.multihash.code !== 0x12 || cid.toString() !== match[1]) return undefined;
    return match[1];
  } catch {
    return undefined;
  }
}

export function isLowSEoaSignature(signature: Hex) {
  const b = toBytes(signature);
  if (b.length !== 65) return false;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = b[64];
  return s <= HALF_ORDER && (v === 27 || v === 28);
}

export type V2Evidence = {
  chainId: number;
  controller: Address;
  projectNode: Hex;
  expectedProdResolver: Address;
  expectedPreviewResolver: Address;
  currentOwner: Address;
  prodContenthash: Hex;
  records: { release: string; manifest: string; build: string; approval: string; controllerPointer: string };
  state: { projectNode: Hex; productionResolver: Address; previewResolver: Address; domainSeparator: Hex; currentReleaseId: Hex; lastSequence: bigint; paused: boolean };
  currentRelease: StoredReleaseV2;
  latestTransition: TransitionV2 | undefined;
};

export type V2Approval = {
  action: "promote" | "rollback";
  sequence: bigint;
  releaseId: Hex;
  approver: Address;
  manifestCid: string;
  manifestDigest: Hex;
  commitDigest: Hex;
  deadline: bigint;
  actionTimestamp: bigint;
  paused: boolean;
  details: string[];
};

/**
 * Every v2 rule a public verifier must check before it may report MATCH (docs/RELEASE_CONTROLLER.md).
 * Throws IntegrityError naming the first rule that failed. The caller still fetches and checks the build
 * manifest bytes (manifestDigest, commitDigest, siteCid, every file).
 */
export async function evaluateV2(e: V2Evidence): Promise<V2Approval> {
  const fail = (message: string): never => { throw new IntegrityError(message); };
  const r = e.records;

  if (!same(r.controllerPointer, e.controller)) fail(`prod ensure.controller is "${r.controllerPointer || "empty"}", not the configured controller ${e.controller}`);
  if (!same(e.state.projectNode, e.projectNode)) fail("Controller projectNode differs from the configured project");
  if (!same(e.state.productionResolver, e.expectedProdResolver) || !same(e.state.previewResolver, e.expectedPreviewResolver)) fail("Controller is bound to different prod/preview resolvers than configured");
  const expectedDomain = hashDomain({ domain: { ...v2Domain(e.chainId, e.controller), chainId: BigInt(e.chainId) }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } });
  if (!same(e.state.domainSeparator, expectedDomain)) fail("Controller domainSeparator differs from ENSureReleaseController v2 on this chain and address");

  if (!/^(0|[1-9][0-9]*)$/.test(r.release)) fail(`ensure.release "${r.release}" is not a canonical decimal sequence (v1-style records under a v2 controller)`);
  const sequence = BigInt(r.release);
  if (sequence !== e.state.lastSequence) fail(`ensure.release ${sequence} differs from controller lastSequence ${e.state.lastSequence}`);
  const manifestCid = canonicalBuildPointerCid(r.build) ?? fail(`ensure.build "${r.build || "empty"}" is not a canonical ipfs:// CIDv1 pointer`);
  if (r.manifest !== r.build) fail("ensure.manifest differs from ensure.build (v2 writes the same build pointer to both)");
  if (!isValidArtifact(e.prodContenthash)) fail("Production contenthash is not a 38-byte raw or dag-pb SHA2-256 CIDv1");

  if (!e.currentRelease.exists) fail(`Controller has no stored release for current ID ${e.state.currentReleaseId}`);
  if (!same(e.currentRelease.contenthash, e.prodContenthash)) fail("Production contenthash differs from the controller's current release (direct write or drift)");
  if (e.currentRelease.buildPointer !== r.build) fail("ensure.build differs from the controller's current release pointer");

  const proof = decodeProof(r.approval);
  if (!same(proof.domainSeparator, e.state.domainSeparator)) fail("Proof domainSeparator differs from this controller's");
  if (proof.struct.sequence !== sequence) fail(`Proof sequence ${proof.struct.sequence} differs from ensure.release ${sequence}`);
  if (!isLowSEoaSignature(proof.signature)) fail("Proof signature is not a 65-byte low-s EOA signature with v = 27/28");
  const digest = actionDigest(e.chainId, e.controller, proof);

  const t = e.latestTransition ?? fail("Controller has no recorded transition");
  if (t.sequence !== sequence || !same(t.toReleaseId, e.state.currentReleaseId)) fail("Latest controller transition does not lead to the current release and sequence");
  if (t.isRollback !== (proof.action === "rollback")) fail("Latest transition type differs from the proof action");
  if (!same(t.actionDigest, digest)) fail("Latest transition actionDigest differs from the proof's EIP-712 digest");
  if (!same(t.proof, r.approval)) fail("ensure.approval differs from the proof stored in the latest transition");
  if (!same(proof.struct.expectedCurrentReleaseId, t.fromReleaseId)) fail("Proof expectedCurrentReleaseId differs from the transition's previous release");
  if (proof.struct.deadline < t.timestamp) fail("Proof deadline had passed when the action executed");

  const signer = await recoverAddress({ hash: digest, signature: proof.signature });
  if (!same(signer, t.authorizer)) fail(`Proof was signed by ${signer}, not the transition's authorizer ${t.authorizer}`);
  if (!same(signer, e.currentOwner)) fail(`Release was approved by ${signer}, who is not the current ENS owner ${e.currentOwner}`);

  if (proof.action === "promote") {
    const p = proof.struct;
    if (!same(p.contenthashHash, keccak256(e.prodContenthash))) fail("Signed contenthashHash differs from the production contenthash");
    if (p.buildPointer !== r.build) fail("Signed buildPointer differs from ensure.build");
    if (!same(p.manifestDigest, e.currentRelease.manifestDigest) || !same(p.commitDigest, e.currentRelease.commitDigest)) fail("Signed digests differ from the controller's stored release");
    if (!same(releaseIdOf(e.projectNode, p), e.state.currentReleaseId)) fail("Signed promotion does not derive the controller's current release ID");
  } else if (!same(proof.struct.targetReleaseId, e.state.currentReleaseId)) {
    fail("Signed rollback target differs from the controller's current release");
  }

  return {
    action: proof.action,
    sequence,
    releaseId: e.state.currentReleaseId,
    approver: t.authorizer,
    manifestCid,
    manifestDigest: e.currentRelease.manifestDigest,
    commitDigest: e.currentRelease.commitDigest,
    deadline: proof.struct.deadline,
    actionTimestamp: t.timestamp,
    paused: e.state.paused,
    details: [digest],
  };
}

/** Recover the EOA that signed a decoded proof (separate so callers can compare it with the current owner). */
export async function recoverProofSigner(chainId: number, controller: Address, proof: DecodedProof): Promise<Address> {
  return recoverAddress({ hash: actionDigest(chainId, controller, proof), signature: proof.signature });
}
