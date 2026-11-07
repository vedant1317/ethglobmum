import { ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { SmokeEvents } from "../src/smoke";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const expectedChainId = 7_794_095;
const rpcTimeoutMs = 15_000;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const rawPrivateKey = requireEnv("ARKIV_PRIVATE_KEY");
  const privateKey = (rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`) as Hex;
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error("ARKIV_PRIVATE_KEY must be a 32-byte hex value");
  const configuredAddress = requireEnv("ARKIV_WRITER_ADDRESS");
  const accessKey = requireEnv("ARKIV_ACCESS_KEY");
  const account = privateKeyToAccount(privateKey);
  const addressMatches = account.address.toLowerCase() === configuredAddress.toLowerCase();
  console.log(`Writer address matches private key: ${addressMatches ? "PASS" : "FAIL"}`);
  console.log(`Writer address: ${account.address}`);
  if (!addressMatches) throw new Error("ARKIV_WRITER_ADDRESS does not match the derived writer address");

  const chain = rabdi({ accessKey });
  const transport = http(undefined, { timeout: rpcTimeoutMs });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });

  const chainId = await publicClient.getChainId();
  console.log(`RPC chain ID: ${chainId} (${chainId === expectedChainId ? "PASS" : "FAIL"})`);
  if (chainId !== expectedChainId) throw new Error(`Expected Rabdi chain ID ${expectedChainId}, received ${chainId}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Writer balance: ${formatEther(balance)} tGLM`);

  // Use an isolated smoke schema so this connectivity check cannot look like a release passport.
  const smokeId = crypto.randomUUID();
  const { entityKey, txHash } = await walletClient.createEntity(
    SmokeEvents,
    { smokeId, createdAt: u64(BigInt(Math.floor(Date.now() / 1000))) },
    { expiration: ExpirationTime.fromDays(1), flags: { readonly: true } },
  );
  console.log("Entity creation transaction: submitted");

  let found;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await publicClient
      .select({ $key: true, $expiresAt: true, smokeId: true })
      .from(SmokeEvents)
      .createdBy(account.address)
      .where(eq("smokeId", smokeId))
      .limit(1)
      .fetch();
    found = result.entities.find((entity) => entity.$key.toLowerCase() === entityKey.toLowerCase());
    if (found) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!found || found.smokeId.value !== smokeId) throw new Error("Created entity was not returned by the public query");

  console.log("Public query: PASS");
  console.log(`Transaction hash: ${txHash}`);
  console.log(`Entity key: ${entityKey}`);
  console.log(`Explorer link: https://rabdi.explorer.arkiv.network/tx/${txHash}`);
  console.log(`Explorer home: ${chain.blockExplorers.default.url}`);
  console.log(`Entity expires at block: ${found.$expiresAt}`);
}

main().catch((error: unknown) => {
  // RPC errors can echo their URL, which includes the access key. Scrub credentials first.
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const secret of [process.env.ARKIV_PRIVATE_KEY, process.env.ARKIV_ACCESS_KEY]) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  console.error(`Arkiv smoke failed: ${message}`);
  process.exitCode = 1;
});
