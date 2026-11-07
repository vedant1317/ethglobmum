/**
 * Mirror an executed ENSure controller transaction (promote or rollback) from Sepolia to Arkiv.
 *
 *   npm run record-controller -- --tx 0x<confirmed Sepolia tx hash> [--project ensure.eth] [--controller 0x…]
 *
 * --controller defaults to releaseController in deployments/sepolia.json.
 * The controller must also be published as the `ensure.controller` text record on prod.<project>,
 * and the transaction must carry a ReleasePromoted or ReleaseRolledBack event (ENSureReleaseController v2).
 * Requires ARKIV_ACCESS_KEY, ARKIV_PRIVATE_KEY and ARKIV_WRITER_ADDRESS (root .env).
 */
import { namehash, type Address, type Hex } from "viem";
import { normalize } from "viem/ens";
import { recordControllerEventFromTransaction } from "../src/controller";
import deployment from "../../deployments/sepolia.json" with { type: "json" };

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const transactionHash = arg("tx") as Hex | undefined;
  if (!transactionHash || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) {
    throw new Error("Pass --tx with the executed Sepolia transaction hash (not a signature or Safe proposal hash)");
  }
  const projectName = arg("project") ?? deployment.projectName;
  const controllerAddress = (arg("controller") ?? deployment.releaseController) as Address | null;
  if (!controllerAddress) throw new Error("No controller: pass --controller or set releaseController in sepolia.json once it is deployed");

  const result = await recordControllerEventFromTransaction({
    projectName,
    projectNode: namehash(normalize(projectName)),
    controllerAddress,
    transactionHash,
  });
  console.log(result.duplicate ? "Already recorded on Arkiv (no new write)." : "Recorded on Arkiv.");
  console.log(`Entity key: ${result.entityKey}`);
  if ("txHash" in result && result.txHash) console.log(`Arkiv tx: https://rabdi.explorer.arkiv.network/tx/${result.txHash}`);
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const secret of [process.env.ARKIV_PRIVATE_KEY, process.env.ARKIV_ACCESS_KEY]) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  console.error(`Controller event not recorded: ${message}`);
  process.exitCode = 1;
});
