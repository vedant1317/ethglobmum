import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { commitDigest, manifestDigest as digestManifest, parseManifest } from "@ensure/core/manifest";
import { decodeContenthash, readText, sameCid } from "@ensure/core/ens";
import { controllerEventId } from "./validate";
import { recordReleaseEvent } from "./write";

/** ABI surface of ENSureReleaseController v2 (contracts/ensure/src/ENSureReleaseController.sol). */
export const controllerV2Abi = parseAbi([
  "event ReleasePromoted(bytes32 indexed releaseId, bytes32 indexed previousReleaseId, address indexed approver, uint64 sequence, bytes32 actionDigest)",
  "event ReleaseRolledBack(bytes32 indexed releaseId, bytes32 indexed fromReleaseId, address indexed approver, uint64 sequence, bytes32 actionDigest)",
  "function projectNode() view returns (bytes32)",
  "function currentOwner() view returns (address)",
  "function getRelease(bytes32 releaseId) view returns ((bool exists, bytes contenthash, string buildPointer, bytes32 manifestDigest, bytes32 commitDigest, address approver, uint64 approvedAt, uint64 firstSequence))",
]);

const ZERO_ID = `0x${"0".repeat(64)}` as Hex;
const SEPOLIA_CHAIN_ID = 11155111;

type StoredRelease = {
  exists: boolean;
  contenthash: Hex;
  buildPointer: string;
  manifestDigest: Hex;
  commitDigest: Hex;
  approver: Address;
  approvedAt: bigint;
  firstSequence: bigint;
};

/** `ipfs://<cid>` → `<cid>`; the controller stores the build manifest pointer in this form. */
export function cidFromBuildPointer(pointer: string) {
  const match = /^ipfs:\/\/([A-Za-z0-9]+)$/.exec(pointer.trim());
  if (!match) throw new Error(`Release buildPointer is not an ipfs:// CID: ${pointer}`);
  return match[1];
}

async function fetchManifest(cid: string) {
  const gateways = (process.env.IPFS_GATEWAYS ?? "https://ipfs.filebase.io,https://ipfs.io,https://dweb.link")
    .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  let lastError = "no IPFS gateway configured";
  for (const gateway of gateways) {
    try {
      const response = await fetch(`${gateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { lastError = `${gateway} returned ${response.status}`; continue; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { manifest: parseManifest(bytes), bytes };
    } catch (error) {
      lastError = `${gateway}: ${(error as Error).message}`;
    }
  }
  throw new Error(`Unable to fetch canonical manifest: ${lastError}`);
}

/**
 * Validates an executed Sepolia ENSureReleaseController v2 transaction (promote or rollback)
 * before mirroring it to Rabdi. Arkiv is history, never authority: every field written here
 * is re-derived from Sepolia and the manifest bytes, never taken from the caller.
 */
export async function recordControllerEventFromTransaction(input: {
  projectName: string;
  projectNode: Hex;
  controllerAddress: Address;
  transactionHash: Hex;
}) {
  const source = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL, { timeout: 10_000 }) });
  if (await source.getChainId() !== SEPOLIA_CHAIN_ID) throw new Error("Source RPC is not Sepolia");
  const receipt = await source.getTransactionReceipt({ hash: input.transactionHash });
  if (receipt.status !== "success") throw new Error("Controller transaction failed");
  const latestBlock = await source.getBlockNumber();
  const confirmations = Number(process.env.ARKIV_SOURCE_CONFIRMATIONS ?? 1);
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error("ARKIV_SOURCE_CONFIRMATIONS must be a positive integer");
  if (latestBlock - receipt.blockNumber + 1n < BigInt(confirmations)) throw new Error("Controller transaction is not sufficiently confirmed");

  const pointer = await readText(source, `prod.${input.projectName}`, "ensure.controller");
  if (!pointer || pointer.toLowerCase() !== input.controllerAddress.toLowerCase()) {
    throw new Error("Controller address does not match prod ENS ensure.controller");
  }
  const code = await source.getCode({ address: input.controllerAddress });
  if (!code || code === "0x") throw new Error("No contract code at controller address");

  const chainProjectNode = await source.readContract({ address: input.controllerAddress, abi: controllerV2Abi, functionName: "projectNode" });
  if (chainProjectNode.toLowerCase() !== input.projectNode.toLowerCase()) throw new Error("Controller projectNode mismatch");

  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === input.controllerAddress.toLowerCase());
  const parsed = parseEventLogs({ abi: controllerV2Abi, logs, strict: true });
  const event = parsed.find((e) => e.eventName === "ReleasePromoted" || e.eventName === "ReleaseRolledBack");
  if (!event) throw new Error("Transaction has no ReleasePromoted or ReleaseRolledBack event from this controller");
  const args = event.args as { releaseId: Hex; previousReleaseId?: Hex; fromReleaseId?: Hex; approver: Address; sequence: bigint; actionDigest: Hex };

  // The approver must have been the ENS owner when the action executed (controller reads it live).
  const ownerAtAction = await source.readContract({
    address: input.controllerAddress, abi: controllerV2Abi, functionName: "currentOwner", blockNumber: receipt.blockNumber,
  });
  if (args.approver.toLowerCase() !== ownerAtAction.toLowerCase()) throw new Error("Event approver was not the ENS owner at the action block");
  if (receipt.from.toLowerCase() !== ownerAtAction.toLowerCase()) throw new Error("Controller action was not sent by the ENS owner");

  const stored = await source.readContract({
    address: input.controllerAddress, abi: controllerV2Abi, functionName: "getRelease", args: [args.releaseId],
  }) as StoredRelease;
  if (!stored.exists) throw new Error("Controller has no stored release for this releaseId");
  if (event.eventName === "ReleasePromoted" && (stored.approver.toLowerCase() !== args.approver.toLowerCase() || stored.firstSequence !== args.sequence)) {
    throw new Error("Promotion log does not match the controller's stored release");
  }

  const manifestCid = cidFromBuildPointer(stored.buildPointer);
  const { manifest, bytes } = await fetchManifest(manifestCid);
  if (digestManifest(bytes).toLowerCase() !== stored.manifestDigest.toLowerCase()) throw new Error("Manifest digest does not match controller release");
  if (commitDigest(manifest.commitSha).toLowerCase() !== stored.commitDigest.toLowerCase()) throw new Error("Manifest commit does not match controller release");
  const siteCid = decodeContenthash(stored.contenthash);
  if (!sameCid(siteCid, manifest.siteCid)) throw new Error("Manifest site CID does not match controller contenthash");

  const fromReleaseId = event.eventName === "ReleasePromoted" ? args.previousReleaseId! : args.fromReleaseId!;
  return recordReleaseEvent({
    projectNode: input.projectNode,
    eventId: controllerEventId(SEPOLIA_CHAIN_ID, input.controllerAddress, input.transactionHash, event.logIndex),
    eventType: event.eventName === "ReleasePromoted" ? "PROMOTED" : "ROLLBACK",
    releaseId: args.releaseId,
    ...(fromReleaseId && fromReleaseId !== ZERO_ID ? { fromReleaseId } : {}),
    commitSha: manifest.commitSha,
    manifestCid,
    manifestDigest: stored.manifestDigest,
    siteCid,
    commitDigest: stored.commitDigest,
    sourceTx: input.transactionHash,
    sourceContract: input.controllerAddress,
    sourceChain: SEPOLIA_CHAIN_ID,
    sourceBlock: receipt.blockNumber,
    sourceLogIndex: event.logIndex,
  });
}
