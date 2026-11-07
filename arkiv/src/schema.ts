import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";

/** Public query fields for version 1 of ENSure's Arkiv release history. */
export const ReleaseEvents = defineSchema("ensure.release-events.v1", {
  projectNode: str().indexed(),
  eventId: str().indexed(),
  eventType: str().indexed(),
  releaseId: str().indexed().optional(),
  fromReleaseId: str().optional(),
  commitSha: str().indexed(),
  manifestCid: str(),
  manifestDigest: str(),
  siteCid: str(),
  commitDigest: str(),
  sourceTx: str().optional(),
  sourceContract: str().optional(),
  sourceChain: u64(),
  sourceBlock: u64().optional(),
  sourceLogIndex: u64().optional(),
  recordedAt: u64(),
});

/** v2 controller: promotions and owner-signed rollbacks; there is no recovery authority. */
export const RELEASE_EVENT_TYPES = ["CANDIDATE", "PROMOTED", "ROLLBACK"] as const;
export type ReleaseEventType = (typeof RELEASE_EVENT_TYPES)[number];
