/**
 * Read ENSure release events from Arkiv (read-only; no private key needed).
 *
 *   npm run history -- [--project ensure.eth] [--writer 0x…] [--type PROMOTED] [--limit 20]
 *
 * --writer defaults to ARKIV_WRITER_ADDRESS: only events created by that trusted writer are shown.
 */
import { namehash, type Address } from "viem";
import { normalize } from "viem/ens";
import { getReleaseHistory } from "../src/query";
import { RELEASE_EVENT_TYPES, type ReleaseEventType } from "../src/schema";
import deployment from "../../deployments/sepolia.json" with { type: "json" };

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const project = arg("project") ?? deployment.projectName;
  const writer = (arg("writer") ?? process.env.ARKIV_WRITER_ADDRESS) as Address | undefined;
  if (!writer) throw new Error("Pass --writer 0x… or set ARKIV_WRITER_ADDRESS");
  const type = arg("type") as ReleaseEventType | undefined;
  if (type && !RELEASE_EVENT_TYPES.includes(type)) throw new Error(`--type must be one of ${RELEASE_EVENT_TYPES.join(", ")}`);
  const limit = Number(arg("limit") ?? 20);

  const projectNode = namehash(normalize(project));
  const result = await getReleaseHistory(projectNode, writer, { eventType: type, limit });
  console.log(`${project} (${projectNode}) · writer ${writer} · ${result.count ?? result.entities.length} event(s) at Rabdi block ${result.blockNumber}`);
  for (const e of result.entities) {
    console.log([
      new Date(Number(e.recordedAt) * 1000).toISOString(),
      e.eventType.padEnd(9),
      e.commitSha.slice(0, 10),
      e.siteCid,
      e.sourceTx ? `tx ${e.sourceTx}` : "",
      `entity ${e.entityKey}`,
    ].join("  "));
  }
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : "Unknown error";
  const key = process.env.ARKIV_ACCESS_KEY;
  if (key) message = message.split(key).join("[REDACTED]");
  console.error(`Arkiv history failed: ${message}`);
  process.exitCode = 1;
});
