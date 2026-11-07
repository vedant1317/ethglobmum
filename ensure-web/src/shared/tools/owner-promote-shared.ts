// Browser-safe primitives shared by the signing page, verifier, and calldata tests.
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { bytesToHex, concatHex, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { dnsEncode } from './names.js';
import { jcs, type Envelope } from './release-approval.js';
export const INLINE_APPROVAL_KEY = 'ensure.approval';
export const RECORD_KEYS = ['ensure.release', 'ensure.manifest', INLINE_APPROVAL_KEY] as const;
export const resolverAbi = parseAbi([
 'function multicall(bytes[] calls) returns (bytes[])',
 'function setContenthash(bytes name,bytes hash)',
 'function setText(bytes name,string key,string value)',
 'function resolve(bytes name,bytes data) view returns (bytes)',
 'function hasRootRoles(uint256 roles,address account) view returns (bool)',
 'function hasRoles(uint256 resource,uint256 roles,address account) view returns (bool)',
]);
export const profileAbi = parseAbi(['function contenthash(bytes32 node) view returns (bytes)', 'function text(bytes32 node,string key) view returns (string)']);
export const bytesCid = async (bytes: Uint8Array) => CID.createV1(raw.code, await sha256.digest(bytes)).toString();
export const ipfsContenthash = (cid: string): Hex => concatHex(['0xe301',bytesToHex(CID.parse(cid).toV1().bytes)]);
export async function buildPromotion(envelope: Envelope) {
 const manifest = jcs(envelope);
 if (new TextEncoder().encode(manifest).length > 8192) throw new Error('Approval exceeds on-chain text size limit');
 const manifestCid = await bytesCid(new TextEncoder().encode(manifest));
 const pointer = 'ipfs://' + manifestCid;
 const dnsName = dnsEncode(envelope.core.name);
 const hash = ipfsContenthash(envelope.core.cid);
 const calls = [
  encodeFunctionData({abi:resolverAbi,functionName:'setContenthash',args:[dnsName,hash]}),
  ...RECORD_KEYS.map(key=>encodeFunctionData({abi:resolverAbi,functionName:'setText',args:[dnsName,key,key===INLINE_APPROVAL_KEY?manifest:pointer]})),
 ];
 return { manifest,manifestCid,pointer,contenthash:hash,calls,data:encodeFunctionData({abi:resolverAbi,functionName:'multicall',args:[calls]}) };
}
