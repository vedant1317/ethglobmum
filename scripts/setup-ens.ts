// One-time setup. Register the parent name first, in the Sepolia ENS app.
//   SETUP_PRIVATE_KEY, SEPOLIA_RPC_URL, PUBLISHER_ADDRESS must be set.
//   pnpm setup-ens platform <name.eth>     quick names
//   pnpm setup-ens project  <name.eth>     a protected project
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { allowLogging, setupPlatform, setupProject, signerFrom } from "@ensure/core/setup";

const [kind, name] = process.argv.slice(2);
const { SETUP_PRIVATE_KEY: key, SEPOLIA_RPC_URL: rpc, PUBLISHER_ADDRESS: publisher, DEPLOY_REGISTRY: log } = process.env;
if (!["platform", "project"].includes(kind) || !name || !key || !rpc || !publisher) {
  console.error("Usage: pnpm setup-ens <platform|project> <name.eth>, with SETUP_PRIVATE_KEY, SEPOLIA_RPC_URL and PUBLISHER_ADDRESS set");
  process.exit(1);
}

const account = privateKeyToAccount(key as Hex);
const transport = http(rpc);
const signer = signerFrom({
  public: createPublicClient({ chain: sepolia, transport }),
  wallet: createWalletClient({ chain: sepolia, transport, account }) as any,
  account: account.address,
});

const file = new URL("../deployments/sepolia.json", import.meta.url);
const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { chainId: 11155111 };

if (kind === "platform") {
  const p = await setupPlatform(signer, name, publisher as Address);
  saved.platform = p;
  console.log(`PLATFORM_NAME=${p.name}\nPLATFORM_REGISTRY=${p.registry}\nPLATFORM_RESOLVER=${p.resolver}`);
} else {
  const p = await setupProject(signer, name, publisher as Address);
  if (log) await allowLogging(signer, log as Address, p.previewName, publisher as Address);
  (saved.projects ??= {})[name] = p;
  console.log(`${p.previewName} is ready. The publisher can write preview, and can't write ${p.prodName}.`);
}
writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
