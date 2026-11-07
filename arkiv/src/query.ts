import { desc, eq } from "@arkiv-network/sdk/query";
import type { Address, Hex } from "viem";
import { arkivPublic } from "./client";
import { ReleaseEvents, type ReleaseEventType } from "./schema";

const projection = {
  $key: true,
  $expiresAt: true,
  projectNode: true,
  eventId: true,
  eventType: true,
  releaseId: true,
  fromReleaseId: true,
  commitSha: true,
  manifestCid: true,
  manifestDigest: true,
  siteCid: true,
  commitDigest: true,
  sourceTx: true,
  sourceContract: true,
  sourceChain: true,
  sourceBlock: true,
  sourceLogIndex: true,
  recordedAt: true,
} as const;

export type ReleaseHistoryItem = {
  entityKey: Hex;
  expiresAt: bigint;
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
  sourceContract?: Address;
  sourceChain: bigint;
  sourceBlock?: bigint;
  sourceLogIndex?: bigint;
  recordedAt: bigint;
  writerAddress: Address;
};

export type ReleaseHistoryFilter = {
  eventType?: ReleaseEventType;
  releaseId?: string;
  commitSha?: string;
  offset?: number;
  limit?: number;
};

type EntityRow = Awaited<ReturnType<ReturnType<typeof queryPage>["fetch"]>>["entities"][number];

function normalize(row: EntityRow, writerAddress: Address): ReleaseHistoryItem {
  return {
    entityKey: row.$key,
    expiresAt: row.$expiresAt,
    projectNode: row.projectNode.value,
    eventId: row.eventId.value,
    eventType: row.eventType.value as ReleaseEventType,
    releaseId: row.releaseId?.value,
    fromReleaseId: row.fromReleaseId?.value,
    commitSha: row.commitSha.value,
    manifestCid: row.manifestCid.value,
    manifestDigest: row.manifestDigest.value,
    siteCid: row.siteCid.value,
    commitDigest: row.commitDigest.value,
    sourceTx: row.sourceTx?.value,
    sourceContract: row.sourceContract?.value as Address | undefined,
    sourceChain: row.sourceChain.value,
    sourceBlock: row.sourceBlock?.value,
    sourceLogIndex: row.sourceLogIndex?.value,
    recordedAt: row.recordedAt.value,
    writerAddress,
  };
}

function queryPage() {
  return arkivPublic.select(projection).from(ReleaseEvents);
}

export async function getReleaseHistory(
  projectNode: string,
  trustedWriter: Address,
  filter: ReleaseHistoryFilter = {},
) {
  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");

  let query = queryPage().createdBy(trustedWriter as Hex).where(eq("projectNode", projectNode));
  if (filter.eventType) query = query.where(eq("eventType", filter.eventType));
  if (filter.releaseId) query = query.where(eq("releaseId", filter.releaseId));
  if (filter.commitSha) query = query.where(eq("commitSha", filter.commitSha));
  const result = await query.orderBy(desc("recordedAt")).limit(limit).offset(offset).withCount().fetch();
  return {
    entities: result.entities.map((row) => normalize(row, trustedWriter)),
    blockNumber: result.blockNumber,
    skipped: result.skipped,
    count: result.count,
  };
}

/** A release can have several events (promotion and later rollback/recovery). */
export async function getReleaseEvents(
  projectNode: string,
  releaseId: string,
  trustedWriter: Address,
) {
  return getReleaseHistory(projectNode, trustedWriter, { releaseId, limit: 100 });
}

export async function getReleaseEventById(eventId: string, trustedWriter: Address) {
  const result = await queryPage()
    .createdBy(trustedWriter as Hex)
    .where(eq("eventId", eventId))
    .limit(1)
    .fetch();
  return result.entities[0] ? normalize(result.entities[0], trustedWriter) : undefined;
}
