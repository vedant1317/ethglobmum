// Read-only tools never load wallet keys or construct a wallet client.
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
export const rpcUrl = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
export const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 30_000 }), cacheTime: 0 });
