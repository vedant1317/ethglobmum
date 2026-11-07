/**
 * Read-only ENSure release history from Arkiv (Rabdi testnet).
 *
 * Arkiv is a queryable mirror, never authority: what production serves is always read from
 * Sepolia. Reads are filtered by schema and by the trusted writer from the address book, and
 * use the public endpoint, so no access key ships in this bundle.
 */
import { namehash, type Address } from "viem";
import { normalize } from "viem/ens";
import { getReleaseHistory, type ReleaseHistoryFilter, type ReleaseHistoryItem } from "@ensure/arkiv/query";
import { deployment } from "@/lib/config";

export type { ReleaseHistoryItem };

export const arkivConfig = deployment.arkiv;

export function arkivEntityUrl(entityKey: string) {
  return `${arkivConfig.explorer}/entity/${entityKey}`;
}

export function arkivWriterUrl(address: string) {
  return `${arkivConfig.explorer}/address/${address}`;
}

export async function readArkivHistory(filter: ReleaseHistoryFilter = {}) {
  const projectNode = namehash(normalize(deployment.projectName));
  const result = await getReleaseHistory(projectNode, arkivConfig.writer as Address, { limit: 50, ...filter });
  return { ...result, projectNode, writer: arkivConfig.writer as Address };
}
