import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import type { Address } from "viem";
import { arkivPublic, getArkivWriter, getArkivWriterAddress } from "./client";
import { ReleaseEvents } from "./schema";
import { validateReleaseEvent, type ReleaseEventInput } from "./validate";

const retentionDays = () => {
  const days = Number(process.env.ARKIV_RETENTION_DAYS ?? 90);
  if (!Number.isInteger(days) || days < 1 || days > 182) {
    throw new Error("ARKIV_RETENTION_DAYS must be an integer between 1 and 182");
  }
  return days;
};

/** Creates a readonly entity; duplicate lookup makes retries safer, but is not atomic. */
export async function recordReleaseEvent(input: ReleaseEventInput) {
  const event = validateReleaseEvent(input);
  const writerAddress = getArkivWriterAddress();
  const existing = await arkivPublic
    .select({ $key: true, $expiresAt: true, eventId: true })
    .from(ReleaseEvents)
    .createdBy(writerAddress)
    .where(eq("eventId", event.eventId))
    .limit(1)
    .fetch();
  if (existing.entities[0]) {
    return {
      entityKey: existing.entities[0].$key,
      expiresAt: existing.entities[0].$expiresAt,
      duplicate: true,
    };
  }

  const writer = getArkivWriter();
  const values = {
    projectNode: event.projectNode.toLowerCase(),
    eventId: event.eventId,
    eventType: event.eventType,
    ...(event.releaseId ? { releaseId: event.releaseId.toLowerCase() } : {}),
    ...(event.fromReleaseId ? { fromReleaseId: event.fromReleaseId.toLowerCase() } : {}),
    commitSha: event.commitSha.toLowerCase(),
    manifestCid: event.manifestCid,
    manifestDigest: event.manifestDigest.toLowerCase(),
    siteCid: event.siteCid,
    commitDigest: event.commitDigest.toLowerCase(),
    ...(event.sourceTx ? { sourceTx: event.sourceTx.toLowerCase() } : {}),
    ...(event.sourceContract ? { sourceContract: event.sourceContract.toLowerCase() } : {}),
    sourceChain: u64(BigInt(event.sourceChain)),
    ...(event.sourceBlock !== undefined ? { sourceBlock: u64(BigInt(event.sourceBlock)) } : {}),
    ...(event.sourceLogIndex !== undefined ? { sourceLogIndex: u64(BigInt(event.sourceLogIndex)) } : {}),
    recordedAt: u64(event.recordedAt),
  };
  const result = await writer.createEntity(ReleaseEvents, values, {
    expiration: ExpirationTime.fromDays(retentionDays()),
    flags: { readonly: true },
  });
  return { ...result, duplicate: false, writerAddress: writerAddress as Address };
}
