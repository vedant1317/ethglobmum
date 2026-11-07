import { keccak256, toBytes, namehash, parseAbi, encodeFunctionData, decodeAbiParameters, BaseError, type Address, type Hex } from 'viem';
import { A, B, S, T, RELEASE_KEY, MANIFEST_KEY, CHAIN_ID, loadConfig, same, isMain, fatal, type DeploymentConfig } from './config.js';
import { client } from './clients.js';
import { dnsEncode } from './names.js';
import { get, cidOf, cidFromContenthash, canonicalCid, Unavailable, isRawCid, cidDigestHex } from './content.js';
import { parseEnvelope, validateManifest, type Expected } from './ensure-manifest.js';
import { INLINE_APPROVAL_KEY, RECORD_KEYS } from './owner-promote-shared.js';
import { hasReleaseAuthority } from './resolver-authority.js';
export interface Verification {
  status: 'GREEN' | 'RED' | 'AMBER'; reason: string; mode: 'LOCAL_FORK_ONLY' | 'LIVE_SEPOLIA'; target: string;
  block?: string; blockHash?: Hex; artifactCid?: string; manifestCid?: string; approver?: Address;
  bytesChecked?: boolean; release?: string; environmentTokenHolder?: Address; authoritySource?: string; manifestStorage?: string;
}
// Public RPC load balancers can route latest-header and snapshot reads to backends at different heights.
export const isSnapshotLag = (reason: string) => /(?:header|block) not found/i.test(reason);
interface State { status: number; expiry: bigint; latestOwner: Address; tokenId: bigint; resource: bigint }
const profile = parseAbi(['function contenthash(bytes32 node) view returns (bytes)', 'function text(bytes32 node,string key) view returns (string)']);
export async function verifyWith(c: DeploymentConfig, selectedClient: typeof client, target: 'prod' | 'preview' = 'prod', snapshotBlock?: bigint): Promise<Verification> {
  const client = selectedClient;
  const name = target === 'prod' ? c.prodName : c.previewName;
  const expectedResolver = target === 'prod' ? c.prodResolver : c.previewResolver;
  const result: Verification = { status: 'AMBER', reason: 'Not checked', mode: c.mode === 'sepolia' ? 'LIVE_SEPOLIA' : 'LOCAL_FORK_ONLY', target: name };
  function assert(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(why); }
  try {
    assert(await client.getChainId() === CHAIN_ID && c.chainId === CHAIN_ID, 'Wrong chain');
    const block = await client.getBlock(snapshotBlock === undefined ? undefined : { blockNumber: snapshotBlock }); const bn = block.number;
    result.block = bn.toString(); result.blockHash = block.hash;
    const read = (address: Address, abi: typeof B.registry, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args, blockNumber: bn });
    const [ethForward, rootEthState, parentState, state, forward, holding, attached, registryImpl, resolverImpl] = await Promise.all([
      read(A.root,B.eth,'getSubregistry',['eth']),
      read(A.root,B.eth,'getState',[BigInt(keccak256(toBytes('eth')))]),
      read(A.eth,B.eth,'getState',[BigInt(keccak256(toBytes(c.label)))]),
      read(c.registry,B.registry,'getState',[BigInt(keccak256(toBytes(target)))]),
      read(c.registry,B.registry,'getResolver',[target]),
      read(A.helper,B.helper,'findParentRegistry',[dnsEncode(name)]),
      read(A.helper,B.helper,'findExactRegistry',[dnsEncode(c.projectName)]),
      read(A.factory,B.factory,'verifyContract',[c.registry]),
      read(A.factory,B.factory,'verifyContract',[expectedResolver]),
    ]) as [Address,State,State,State,Address,Address,Address,Address,Address];
    assert(same(ethForward,A.eth), 'Root eth forward pointer differs from pinned protocol');
    assert(rootEthState.status === 2 && rootEthState.expiry > block.timestamp, 'Inactive exact eth ancestor');
    assert(parentState.status === 2 && parentState.expiry > block.timestamp && same(parentState.latestOwner,c.owner), 'Inactive or unexpected exact project owner');
    assert(parentState.resource.toString() === c.projectResource, 'Parent registration resource/version changed');
    assert(state.status === 2 && state.expiry > block.timestamp, 'Inactive or expired exact environment registration');
    result.environmentTokenHolder = state.latestOwner; // Informational ERC-1155 holder, NOT resolver authority.
    result.authoritySource = 'Configured project owner signature + effective resolver contenthash/text write or admin roles';
    if (target === 'prod') assert(state.resource.toString() === c.prodResource, 'Production registration resource/version changed');
    assert(same(holding,c.registry) && same(attached,c.registry), 'Exact forward hierarchy mismatch');
    assert(same(forward,expectedResolver), 'Environment resolver routing changed');
    assert(same(registryImpl,A.registryImpl) && same(resolverImpl,A.resolverImpl), 'Factory/current implementation mismatch');
    assert(!same(c.prodResolver,c.previewResolver), 'Unsafe shared production/preview resolver');
    if (target === 'prod') {
      const ciS = await read(c.prodResolver,B.resolver,'hasRootRoles',[S,c.ci]);
      const ciSA = await read(c.prodResolver,B.resolver,'hasRootRoles',[S<<128n,c.ci]);
      const ciM = await read(c.prodResolver,B.resolver,'hasRoles',[BigInt(keccak256(toBytes(MANIFEST_KEY))),T,c.ci]);
      const manifestCount = await read(c.prodResolver,B.resolver,'getAssigneeCount',[BigInt(keccak256(toBytes(MANIFEST_KEY))),T]);
      const ciT = await read(c.prodResolver,B.resolver,'hasRoles',[BigInt(keccak256(toBytes(RELEASE_KEY))),T,c.ci]);
      // EAC returns (nybble-packed counts, mask), NOT a scalar headcount.
      const sCount = await read(c.prodResolver,B.resolver,'getAssigneeCount',[0n,S]);
      const tCount = await read(c.prodResolver,B.resolver,'getAssigneeCount',[0n,T]);
      const keyCount = await read(c.prodResolver,B.resolver,'getAssigneeCount',[BigInt(keccak256(toBytes(RELEASE_KEY))),T]);
      const ownerS = await read(c.prodResolver,B.resolver,'hasRootRoles',[S,c.owner]);
      const ownerT = await read(c.prodResolver,B.resolver,'hasRootRoles',[T,c.owner]);
      const ownerSA = await read(c.prodResolver,B.resolver,'hasRootRoles',[S<<128n,c.owner]);
      const ownerTA = await read(c.prodResolver,B.resolver,'hasRootRoles',[T<<128n,c.owner]);
      assert(!ciM && Array.isArray(manifestCount) && manifestCount[0] === 0n && !ciS && !ciSA && !ciT && (ownerS || ownerSA) && (ownerT || ownerTA) && Array.isArray(sCount) && sCount[0] === (ownerS ? S : 0n) && Array.isArray(tCount) && tCount[0] === (ownerT ? T : 0n) && Array.isArray(keyCount) && keyCount[0] === 0n, 'Unexpected production writer grants');
      for (const key of RECORD_KEYS) {
        const resource = BigInt(keccak256(toBytes(key)));
        const [ciWrite,ciAdmin,directCount] = await Promise.all([
          read(c.prodResolver,B.resolver,'hasRoles',[resource,T,c.ci]),
          read(c.prodResolver,B.resolver,'hasRoles',[resource,T<<128n,c.ci]),
          read(c.prodResolver,B.resolver,'getAssigneeCount',[resource,T]),
        ]);
        assert(!ciWrite && !ciAdmin && Array.isArray(directCount) && directCount[0] === 0n, 'Unexpected production approval-record writer grants');
      }
    }
    const [encodedHash,encodedText,encodedManifest] = await Promise.all([
      read(expectedResolver,B.resolver,'resolve',[dnsEncode(name),encodeFunctionData({ abi: profile,functionName: 'contenthash',args: [namehash(name)] })]),
      read(expectedResolver,B.resolver,'resolve',[dnsEncode(name),encodeFunctionData({ abi: profile,functionName: 'text',args: [namehash(name),RELEASE_KEY] })]),
      read(expectedResolver,B.resolver,'resolve',[dnsEncode(name),encodeFunctionData({ abi: profile,functionName: 'text',args: [namehash(name),MANIFEST_KEY] })]),
    ]) as [Hex,Hex,Hex];
    const hash = decodeAbiParameters([{ type: 'bytes' }],encodedHash)[0];
    const pointer = decodeAbiParameters([{ type: 'string' }],encodedText)[0];
    const manifestPointer = decodeAbiParameters([{ type: 'string' }],encodedManifest)[0];
    assert(pointer === manifestPointer, 'Release and manifest pointers disagree');
    assert(hash !== '0x', 'No artifact contenthash set');
    result.artifactCid = cidFromContenthash(hash);
    assert(pointer.startsWith('ipfs://') && !pointer.slice(7).includes('/'), 'No owner-approved CID-only release manifest pointer');
    result.manifestCid = canonicalCid(pointer.slice(7));
    // New wallet releases publish their canonical signed envelope directly in text.
    // The IPFS pointer is still a strict raw/sha2-256 commitment; no public pin is claimed.
    const encodedApproval = await read(expectedResolver,B.resolver,'resolve',[dnsEncode(name),encodeFunctionData({abi:profile,functionName:'text',args:[namehash(name),INLINE_APPROVAL_KEY]})]) as Hex;
    const inlineApproval = decodeAbiParameters([{type:'string'}],encodedApproval)[0];
    let manifestBytes: Uint8Array;
    if (inlineApproval) {
      manifestBytes = new TextEncoder().encode(inlineApproval);
      assert(manifestBytes.length <= 8192, 'Inline approval exceeds size limit');
      assert(await cidOf(manifestBytes) === result.manifestCid, 'Inline approval bytes differ from manifest CID');
      result.manifestStorage = 'ONCHAIN_CANONICAL_ENVELOPE_RAW_CID_COMMITMENT';
    } else { manifestBytes = await get(result.manifestCid); result.manifestStorage = 'LOCAL_RAW_CID_STORE'; }
    const envelope = parseEnvelope(manifestBytes);
    const isRawArtifact = isRawCid(result.artifactCid);
    let artifactBytes: Uint8Array | undefined;
    if (isRawArtifact) {
      artifactBytes = await get(result.artifactCid);
    } else {
      // UnixFS directory CID: commit to the CID multihash digest (same as signed buildHash).
      assert(envelope.core.buildHash === cidDigestHex(result.artifactCid), 'Signed buildHash must equal directory CID multihash digest');
    }
    const expected: Expected = { chainId: CHAIN_ID, name, projectName: c.projectName, parentRegistry: A.eth, registry: c.registry, parentResource: parentState.resource.toString(), resource: state.resource.toString(), resolver: expectedResolver, owner: c.owner, minRelease: target === 'prod' ? c.minRelease : '0' };
    result.approver = await validateManifest(envelope,expected,result.artifactCid,block.timestamp,artifactBytes);
    assert(await hasReleaseAuthority((method,args)=>read(expectedResolver,B.resolver,method,args),result.approver), 'Approved signer lacks resolver CONTENTHASH/TEXT write or admin authority');
    // Guard against a reorg between snapshot and finishing reads.
    assert((await client.getBlock({ blockNumber: bn })).hash === block.hash, 'Block changed during verification');
    result.release = envelope.core.release; result.bytesChecked = true;
    result.status = 'GREEN';
    result.reason = isRawArtifact
      ? 'Owner-approved artifact pointer and raw fixture bytes match; not proof of safe code or a real repository build'
      : 'Owner-approved directory CID pointer and digest commitment match; not proof of safe code';
  } catch (e) {
    result.status = e instanceof Unavailable || e instanceof BaseError ? 'AMBER' : 'RED';
    result.reason = e instanceof Error ? e.message : String(e);
  }
  return result;
}
export async function verify(target: 'prod' | 'preview' = 'prod') { return verifyWith(loadConfig(), client, target); }
if (isMain(import.meta.url)) {
  const target = process.argv[2] ?? 'prod';
  if (target !== 'prod' && target !== 'preview') fatal(new Error('Usage: verify.ts [prod|preview]'));
  else verify(target).then(r => { console.log(JSON.stringify(r,null,2)); process.exitCode = r.status === 'GREEN' ? 0 : r.status === 'RED' ? 2 : 3; }).catch(fatal);
}
