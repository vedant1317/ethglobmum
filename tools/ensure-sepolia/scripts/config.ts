import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Address, Hex } from 'viem';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHAIN_ID = 11155111;
export const FORK_BLOCK = Number(process.env.FORK_BLOCK ?? '12076677');
if(!Number.isSafeInteger(FORK_BLOCK)||FORK_BLOCK<1)throw new Error('Invalid FORK_BLOCK');
export const SOURCE_COMMIT = '07e55a056f5b6a9c90119f501bdd05714e67dddd';
export const A = {
  root: '0xb458d6a3a77919449d03e7a6903c26827c1ec43f',
  eth: '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4',
  factory: '0xda70306c98e97ece36f997a21368e53298572991',
  registryImpl: '0x9bd8a88719068d09ecee662f36c0e3856708366a',
  resolverImpl: '0x115eb53f0c60696633855f90b138178fb40b2b2c',
  helper: '0xd453e5bdb62cc3bea84341b1e306319c8ffd7dfe',
  registrar: '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3',
  usdc: '0x240b0316df57887dbbe58b586508b19e633a14aa',
} as const satisfies Record<string, Address>;
export { B } from './protocol-abi.js';
export const S = 1n << 8n, T = 1n << 4n, L = 1n << 28n;
export const REG_OPS = 1n | (1n << 8n) | (1n << 12n) | (1n << 16n) | (1n << 20n) | (1n << 24n);
export const admin = (bits: bigint) => bits | (bits << 128n);
export const BUILD_KEY = 'ensure.build', RELEASE_KEY = 'ensure.release', MANIFEST_KEY = 'ensure.manifest';
export interface LocalConfig {
  mode: 'local-sepolia-fork'; chainId: number; forkBlock: number; sourceCommit: string;
  label: string; projectName: string; prodName: string; previewName: string;
  registry: Address; prodResolver: Address; previewResolver: Address; owner: Address; ci: Address;
  projectResource: string; prodResource: string; minRelease: string;
  history: { release: string; cid: string; manifestCid: string; transaction: Hex }[];
}
export type DeploymentConfig = Omit<LocalConfig, 'mode'> & { mode: 'local-sepolia-fork' | 'sepolia' };
export const CONFIG_FILE = resolve(REPO_ROOT, 'deployments/sepolia.json');
export const loadConfig = (): DeploymentConfig => JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
export function fatal(error: unknown) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
