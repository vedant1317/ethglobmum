import canonicalizeModule from 'canonicalize';
import { keccak256, toBytes, hashTypedData, type Address, type Hex } from 'viem';
const canonicalize = canonicalizeModule as unknown as (x: unknown) => string | undefined;
export const jcs = (x: unknown): string => { const s = canonicalize(x); if (s === undefined) throw new Error('Not canonical JSON'); return s; };
export interface Core {
  schemaVersion: 1; chainId: string; name: string; projectName: string;
  parentRegistry: Address; registry: Address; parentResource: string; resource: string; resolver: Address;
  cid: string; commit: string; buildHash: Hex; release: string; approver: Address;
  issuedAt: string; validUntil: string; previousManifest: string;
}
export interface Envelope { core: Core; signature: Hex }
export interface Expected {
  chainId: number; name: string; projectName: string; parentRegistry: Address; registry: Address;
  parentResource: string; resource: string; resolver: Address; owner: Address; minRelease: string;
}
export const types = { ReleaseApproval: [{ name: 'coreHash', type: 'bytes32' }] } as const;
export const domain = (chainId: number) => ({ name: 'ENSure', version: '1', chainId });
export const coreHash = (core: Core): Hex => keccak256(toBytes(jcs(core)));
export const typedApproval = (core: Core) => ({ domain: domain(Number(core.chainId)), types, primaryType: 'ReleaseApproval' as const, message: { coreHash: coreHash(core) } });
export const approvalDigest = (core: Core) => hashTypedData(typedApproval(core));
