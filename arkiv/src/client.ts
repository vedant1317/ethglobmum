import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const nodeEnv = typeof process === "undefined" ? {} : process.env;
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const accessKey = () => nodeEnv.ARKIV_ACCESS_KEY ?? viteEnv.VITE_ARKIV_ACCESS_KEY ?? "";

function normalizedPrivateKey(value: string | undefined): Hex {
  if (!value) throw new Error("Missing ARKIV_PRIVATE_KEY");
  const key = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("ARKIV_PRIVATE_KEY must be a 32-byte hex value");
  return key;
}

export const arkivChain = () => rabdi({ accessKey: accessKey() });

/** Read-only client. Safe to use in server and browser bundles with an access key. */
export const arkivPublic = createPublicClient({ chain: arkivChain(), transport: http(undefined, { timeout: 10_000 }) });

export function getArkivWriter() {
  const account = privateKeyToAccount(normalizedPrivateKey(process.env.ARKIV_PRIVATE_KEY));
  const configuredAddress = process.env.ARKIV_WRITER_ADDRESS;
  if (configuredAddress && configuredAddress.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("ARKIV_WRITER_ADDRESS does not match ARKIV_PRIVATE_KEY");
  }
  return createWalletClient({ chain: arkivChain(), transport: http(undefined, { timeout: 10_000 }), account });
}

export function getArkivWriterAddress() {
  const privateKey = process.env.ARKIV_PRIVATE_KEY;
  if (!privateKey) {
    const address = process.env.ARKIV_WRITER_ADDRESS;
    if (!address) throw new Error("Set ARKIV_WRITER_ADDRESS or configure ARKIV_PRIVATE_KEY");
    return address as `0x${string}`;
  }
  const address = privateKeyToAccount(normalizedPrivateKey(privateKey)).address;
  const configuredAddress = process.env.ARKIV_WRITER_ADDRESS;
  if (configuredAddress && configuredAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error("ARKIV_WRITER_ADDRESS does not match ARKIV_PRIVATE_KEY");
  }
  return address;
}
