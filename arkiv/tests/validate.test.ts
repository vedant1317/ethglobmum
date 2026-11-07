import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { candidateEventId, controllerEventId, validateReleaseEvent, type ReleaseEventInput } from "../src/validate";
import { RELEASE_EVENT_TYPES } from "../src/schema";

const commitSha = "07e55a056f5b6a9c90119f501bdd05714e67dddd";
const hex32 = (c: string) => `0x${c.repeat(64)}`;
const siteCid = "bafybeicxywmb2dczdj55tpw7j2mh6alllmxutpblzqns5xc33refxjchh4";
const manifestCid = "bafkreiayn2ra3i4ei7hqywp2mku57lvdxxgkimkrpob5hkoab26carhjli";

const candidate = (over: Partial<ReleaseEventInput> = {}): ReleaseEventInput => ({
  projectNode: hex32("a"),
  eventId: candidateEventId("ensure.eth", "deploy-1", commitSha),
  eventType: "CANDIDATE",
  commitSha,
  manifestCid,
  manifestDigest: hex32("b"),
  siteCid,
  commitDigest: keccak256(toBytes(commitSha)),
  sourceTx: hex32("c"),
  sourceChain: 11155111,
  ...over,
});

const promoted = (over: Partial<ReleaseEventInput> = {}): ReleaseEventInput => candidate({
  eventType: "PROMOTED",
  releaseId: hex32("d"),
  sourceContract: "0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7",
  eventId: controllerEventId(11155111, "0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7", hex32("c"), 0),
  ...over,
});

test("accepts a well-formed candidate and stamps recordedAt", () => {
  const before = BigInt(Math.floor(Date.now() / 1000));
  const event = validateReleaseEvent(candidate());
  assert.ok(event.recordedAt >= before);
});

test("keeps an explicit recordedAt", () => {
  assert.equal(validateReleaseEvent(candidate({ recordedAt: 1_700_000_000 })).recordedAt, 1_700_000_000n);
});

test("accepts a well-formed controller promotion", () => {
  assert.doesNotThrow(() => validateReleaseEvent(promoted()));
});

test("rejects a commitDigest that does not match commitSha", () => {
  assert.throws(() => validateReleaseEvent(candidate({ commitDigest: hex32("e") })), /commitDigest does not match/);
});

test("candidates cannot claim a controller releaseId", () => {
  assert.throws(() => validateReleaseEvent(candidate({ releaseId: hex32("d") })), /cannot claim a controller releaseId/);
});

test("candidates need the confirmed preview transaction", () => {
  assert.throws(() => validateReleaseEvent(candidate({ sourceTx: undefined })), /require the confirmed preview publication/);
});

test("controller events need releaseId, sourceTx and sourceContract", () => {
  for (const missing of ["releaseId", "sourceTx", "sourceContract"] as const) {
    assert.throws(() => validateReleaseEvent(promoted({ [missing]: undefined })), /controller events require/, missing);
  }
});

test("rejects malformed fields", () => {
  assert.throws(() => validateReleaseEvent(candidate({ projectNode: "0x1234" })), /projectNode/);
  assert.throws(() => validateReleaseEvent(candidate({ commitSha: "abc" })), /commitSha/);
  assert.throws(() => validateReleaseEvent(candidate({ siteCid: "not-a-cid" })), /siteCid must be a valid IPFS CID/);
  assert.throws(() => validateReleaseEvent(candidate({ sourceTx: "0xdead" })), /sourceTx/);
  assert.throws(() => validateReleaseEvent(promoted({ sourceContract: "0xnope" })), /sourceContract/);
  assert.throws(() => validateReleaseEvent(candidate({ eventType: "DELETED" as never })), /eventType is invalid/);
  assert.throws(() => validateReleaseEvent(candidate({ sourceChain: -1 })), /sourceChain/);
});

test("event ids are deterministic and case-insensitive", () => {
  assert.equal(candidateEventId("ENSure.eth", "Deploy-1", commitSha.toUpperCase()), candidateEventId("ensure.eth", "deploy-1", commitSha));
  assert.notEqual(controllerEventId(11155111, "0xabc", hex32("c"), 0), controllerEventId(11155111, "0xabc", hex32("c"), 1));
});

test("schema event types cover the release lifecycle", () => {
  assert.deepEqual([...RELEASE_EVENT_TYPES], ["CANDIDATE", "PROMOTED", "ROLLBACK"]);
});
