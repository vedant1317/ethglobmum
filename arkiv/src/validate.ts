import { isAddress, keccak256, toBytes } from "viem";
import { CID } from "multiformats/cid";
import { MAX_STRING_BYTES } from "@arkiv-network/sdk/schema";
import { RELEASE_EVENT_TYPES, type ReleaseEventType } from "./schema";

const HEX32 = /^0x[0-9a-f]{64}$/i;
const TX_HASH = /^0x[0-9a-f]{64}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export type ReleaseEventInput = {
  projectNode: string;
  eventId: string;
  eventType: ReleaseEventType;
  releaseId?: string;
  fromReleaseId?: string;
  commitSha: string;
  manifestCid: string;
  manifestDigest: string;
  siteCid: string;
  commitDigest: string;
  sourceTx?: string;
  sourceContract?: string;
  sourceChain: number;
  sourceBlock?: bigint | number;
  sourceLogIndex?: bigint | number;
  recordedAt?: bigint | number;
};

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

function checkString(field: string, value: string, pattern?: RegExp) {
  if (!value || utf8Length(value) > MAX_STRING_BYTES) throw new Error(`${field} must be 1–${MAX_STRING_BYTES} UTF-8 bytes`);
  if (pattern && !pattern.test(value)) throw new Error(`${field} has an invalid format`);
}

function checkCid(field: string, value: string) {
  checkString(field, value);
  try { CID.parse(value); } catch { throw new Error(`${field} must be a valid IPFS CID`); }
}

function checkU64(field: string, value: bigint | number | undefined, required: boolean) {
  if (value === undefined) {
    if (required) throw new Error(`${field} is required`);
    return;
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  const n = BigInt(value);
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error(`${field} is outside u64 range`);
}

export function validateReleaseEvent(input: ReleaseEventInput): ReleaseEventInput & { recordedAt: bigint } {
  checkString("projectNode", input.projectNode, HEX32);
  checkString("eventId", input.eventId);
  if (!RELEASE_EVENT_TYPES.includes(input.eventType)) throw new Error("eventType is invalid");
  if (input.releaseId !== undefined) checkString("releaseId", input.releaseId, HEX32);
  if (input.fromReleaseId !== undefined) checkString("fromReleaseId", input.fromReleaseId, HEX32);
  checkString("commitSha", input.commitSha, COMMIT_SHA);
  checkCid("manifestCid", input.manifestCid);
  checkString("manifestDigest", input.manifestDigest, HEX32);
  checkCid("siteCid", input.siteCid);
  checkString("commitDigest", input.commitDigest, HEX32);
  if (input.sourceTx !== undefined) checkString("sourceTx", input.sourceTx, TX_HASH);
  if (input.sourceContract !== undefined && !isAddress(input.sourceContract)) {
    throw new Error("sourceContract must be an EVM address");
  }
  checkU64("sourceChain", input.sourceChain, true);
  checkU64("sourceBlock", input.sourceBlock, false);
  checkU64("sourceLogIndex", input.sourceLogIndex, false);
  checkU64("recordedAt", input.recordedAt, false);

  if (input.eventType === "CANDIDATE" && input.releaseId !== undefined) {
    throw new Error("candidate events cannot claim a controller releaseId");
  }
  if (input.eventType === "CANDIDATE" && !input.sourceTx) {
    throw new Error("candidate events require the confirmed preview publication transaction");
  }
  if (input.eventType !== "CANDIDATE" && (!input.releaseId || !input.sourceTx || !input.sourceContract)) {
    throw new Error("controller events require releaseId, sourceTx, and sourceContract");
  }
  const expectedCommitDigest = keccak256(toBytes(input.commitSha.toLowerCase()));
  if (input.commitDigest.toLowerCase() !== expectedCommitDigest.toLowerCase()) {
    throw new Error("commitDigest does not match commitSha");
  }
  return { ...input, recordedAt: BigInt(input.recordedAt ?? Math.floor(Date.now() / 1000)) };
}

export function candidateEventId(projectId: string, deployId: string, commitSha: string) {
  return keccak256(toBytes(`candidate:${projectId.toLowerCase()}:${deployId.toLowerCase()}:${commitSha.toLowerCase()}`));
}

export function controllerEventId(
  chainId: number,
  controller: string,
  transactionHash: string,
  logIndex: number,
) {
  return keccak256(toBytes(
    `controller:${chainId}:${controller.toLowerCase()}:${transactionHash.toLowerCase()}:${logIndex}`,
  ));
}
