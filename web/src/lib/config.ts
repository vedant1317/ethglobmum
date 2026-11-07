import { fallback, http, createPublicClient, type Address } from "viem";
import { sepolia } from "viem/chains";
import deploymentFile from "../../../deployments/sepolia.json";

export type Deployment = typeof deploymentFile & {
  protocol: {
    rootRegistry: Address;
    ethRegistry: Address;
    universalResolver: Address;
    universalHelper: Address;
    verifiableFactory: Address;
    registryImplementation: Address;
    resolverImplementation: Address;
  };
  releaseController: Address | null;
};

export const deployment = deploymentFile as Deployment;
export const GATEWAYS = [
  import.meta.env.VITE_PINATA_GATEWAY,
  deployment.pinataGateway,
  ...(import.meta.env.VITE_IPFS_GATEWAYS ?? "").split(","),
  "https://ipfs.io",
  "https://dweb.link",
].filter((value): value is string => Boolean(value)).map((value) => value.replace(/\/$/, ""));

const configuredRpc = import.meta.env.VITE_SEPOLIA_RPC_URL?.trim();
export const sepoliaRpc = fallback([
  ...(configuredRpc ? [http(configuredRpc, { timeout: 10_000, retryCount: 1 })] : []),
  http("https://ethereum-sepolia-rpc.publicnode.com", { timeout: 10_000, retryCount: 1 }),
  http("https://rpc.sepolia.org", { timeout: 10_000, retryCount: 1 }),
]);

export const publicClient = createPublicClient({ chain: sepolia, transport: sepoliaRpc });

export function resolverForName(name: string): Address | undefined {
  if (name.toLowerCase() === deployment.prodName.toLowerCase()) return deployment.prodResolver as Address;
  if (name.toLowerCase() === deployment.previewName.toLowerCase()) return deployment.previewResolver as Address;
  return undefined;
}

export function environmentLabel(name: string): "Production" | "Preview" | "Unknown" {
  if (name.toLowerCase() === deployment.prodName.toLowerCase()) return "Production";
  if (name.toLowerCase() === deployment.previewName.toLowerCase()) return "Preview";
  return "Unknown";
}
