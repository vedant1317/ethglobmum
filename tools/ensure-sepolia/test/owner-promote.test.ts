import { test } from 'vitest';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData,encodeAbiParameters,namehash,keccak256,toBytes,type Address } from 'viem';
import { A,S,T,CHAIN_ID,type DeploymentConfig } from '../scripts/config.js';
import { put,sha256Hex } from '../scripts/content.js';
import { typedApproval,type Core,type Envelope } from '../scripts/ensure-manifest.js';
import { buildPromotion,resolverAbi,profileAbi,RECORD_KEYS,INLINE_APPROVAL_KEY,bytesCid } from '../scripts/owner-promote-shared.js';
import { hasReleaseAuthority } from '../scripts/resolver-authority.js';
import { verifyWith } from '../scripts/verify.js';
import { dnsEncode } from '../scripts/names.js';
const owner=privateKeyToAccount(keccak256(toBytes('ENSure isolated owner promote test account')));
const other=privateKeyToAccount(keccak256(toBytes('ENSure isolated unrelated signer test')));
const addr=(d:string)=>('0x'+d.repeat(40)) as Address;
const c:DeploymentConfig={mode:'sepolia',chainId:CHAIN_ID,forkBlock:0,sourceCommit:'unit',label:'fixture',projectName:'fixture.eth',prodName:'prod.fixture.eth',previewName:'preview.fixture.eth',registry:addr('1'),prodResolver:addr('2'),previewResolver:addr('3'),owner:owner.address,ci:addr('5'),projectResource:'42',prodResource:'24',minRelease:'3',history:[]};
async function fixture(){const artifact=toBytes('ENSure same approved test fixture');const cid=await put(artifact);const core:Core={schemaVersion:1,chainId:String(CHAIN_ID),name:c.prodName,projectName:c.projectName,parentRegistry:A.eth,registry:c.registry,parentResource:c.projectResource,resource:c.prodResource,resolver:c.prodResolver,cid,commit:'LOCAL_FIXTURE_NO_GIT_COMMIT',buildHash:await sha256Hex(artifact),release:'4',approver:c.owner,issuedAt:'999',validUntil:'2000',previousManifest:''};return {core,signature:await owner.signTypedData(typedApproval(core))};}
async function mockClient(envelope:Envelope,{missingRole=false,wrongHolder=false,tamperedInline=false,expiredRegistration=false,changedResolver=false,extraWriter=false,adminOnly=false}:{missingRole?:boolean;wrongHolder?:boolean;tamperedInline?:boolean;expiredRegistration?:boolean;changedResolver?:boolean;extraWriter?:boolean;adminOnly?:boolean}={}){
 const p=await buildPromotion(envelope);const hash='0x'+'a'.repeat(64);
 const records:Record<string,string>=Object.fromEntries(RECORD_KEYS.map(key=>[key,key===INLINE_APPROVAL_KEY?(tamperedInline?p.manifest+' ':p.manifest):p.pointer]));
 const state=(resource:bigint,latestOwner:Address)=>({status:2,expiry:expiredRegistration?500n:3000n,latestOwner,tokenId:1n,resource});
 return {
  getChainId:async()=>CHAIN_ID,
  getBlock:async()=>({number:123n,timestamp:1000n,hash}),
  readContract:async({address,functionName,args,blockNumber}:any)=>{
   assert.equal(blockNumber,123n,'all reads pinned to snapshot');
   if(functionName==='getSubregistry')return A.eth;
   if(functionName==='getState'){if(address===A.root)return state(1n,c.owner);if(address===A.eth)return state(42n,c.owner);return state(24n,wrongHolder?addr('8'):c.owner);}
   if(functionName==='getResolver')return changedResolver?addr('9'):c.prodResolver;
   if(functionName==='findExactOwner')return wrongHolder?addr('8'):c.owner;
   if(functionName==='findParentRegistry'||functionName==='findExactRegistry')return c.registry;
   if(functionName==='verifyContract')return args[0]===c.registry?A.registryImpl:A.resolverImpl;
   if(functionName==='hasRootRoles'||functionName==='hasRoles'){
    const account=args.at(-1);const role=args.at(-2);
    if(account===c.ci)return false;
    if(missingRole&&functionName==='hasRoles'&&args[0]===BigInt(keccak256(toBytes(INLINE_APPROVAL_KEY))))return false;
    return adminOnly?(role===(S<<128n)||role===(T<<128n)):(role===S||role===T);
   }
   if(functionName==='getAssigneeCount')return [args[0]===0n?(extraWriter?args[1]*2n:adminOnly?0n:args[1]):0n,0n];
   if(functionName==='resolve'){
    const decoded=decodeFunctionData({abi:profileAbi,data:args[1]});assert.equal(decoded.args![0],namehash(c.prodName));
    return decoded.functionName==='contenthash'?encodeAbiParameters([{type:'bytes'}],[p.contenthash]):encodeAbiParameters([{type:'string'}],[records[String(decoded.args![1])]??'']);
   }
   throw new Error('Unhandled mock read '+functionName);
  },
 } as unknown as Parameters<typeof verifyWith>[1];
}
test('Multicall ABI encodes unchanged contenthash and three exact ensure records',async()=>{
 const e=await fixture(),p=await buildPromotion(e);
 const decoded=decodeFunctionData({abi:resolverAbi,data:p.data});assert.equal(decoded.functionName,'multicall');
 const calls=decoded.args![0] as readonly `0x${string}`[];assert.equal(calls.length,4);
 const content=decodeFunctionData({abi:resolverAbi,data:calls[0]});assert.equal(content.functionName,'setContenthash');assert.deepEqual(content.args,[dnsEncode(c.prodName),p.contenthash]);
 for(let i=0;i<RECORD_KEYS.length;i++){const key=RECORD_KEYS[i];const call=decodeFunctionData({abi:resolverAbi,data:calls[i+1]});assert.equal(call.functionName,'setText');assert.deepEqual(call.args,[dnsEncode(c.prodName),key,key===INLINE_APPROVAL_KEY?p.manifest:p.pointer]);}
 assert.equal(await bytesCid(toBytes(p.manifest)),p.manifestCid);
});
test('GREEN: old environment token holder is informational, owner signature and roles authorize release',async()=>{const e=await fixture();const r=await verifyWith(c,await mockClient(e,{wrongHolder:true}));assert.equal(r.status,'GREEN',r.reason);assert.equal(r.environmentTokenHolder,addr('8'));assert.equal(r.approver,c.owner);assert.equal(r.manifestStorage,'ONCHAIN_CANONICAL_ENVELOPE_RAW_CID_COMMITMENT');});
test('RED: missing approval text authority',async()=>{const e=await fixture();const r=await verifyWith(c,await mockClient(e,{missingRole:true}));assert.equal(r.status,'RED');assert.match(r.reason,/lacks resolver/);});
test('RED: old signer cannot approve after configured ownership changed',async()=>{const e=await fixture();e.signature=await other.signTypedData(typedApproval(e.core));const r=await verifyWith(c,await mockClient(e,{wrongHolder:true}));assert.equal(r.status,'RED');assert.match(r.reason,/signature/);});
test('RED: inline manifest must match raw CID exactly',async()=>{const e=await fixture();const r=await verifyWith(c,await mockClient(e,{tamperedInline:true}));assert.equal(r.status,'RED');assert.match(r.reason,/bytes differ/);});
test('RED: environment registration expiry remains strict despite informational holder',async()=>{const e=await fixture();const r=await verifyWith(c,await mockClient(e,{expiredRegistration:true}));assert.equal(r.status,'RED');assert.match(r.reason,/Inactive/);});
test('RED: resolver routing and exclusive production writers remain strict',async()=>{const e=await fixture();for(const option of [{changedResolver:true},{extraWriter:true}]){const r=await verifyWith(c,await mockClient(e,option));assert.equal(r.status,'RED');assert.match(r.reason,/routing|writer grants/);}});
test('Effective resolver authority accepts write or matching admin roles, rejects missing CONTENTHASH/TEXT',async()=>{
 assert.equal(await hasReleaseAuthority(async()=>true,c.owner),true);
 assert.equal(await hasReleaseAuthority(async(_method,args)=>BigInt(args.at(-2) as bigint)>=(1n<<128n),c.owner),true);
 assert.equal(await hasReleaseAuthority(async(method)=>method!=='hasRootRoles',c.owner),false);
 assert.equal(await hasReleaseAuthority(async(method)=>method==='hasRootRoles',c.owner),false);
});

test('GREEN: configured signer with corresponding resolver admin authority is accepted',async()=>{const e=await fixture();const r=await verifyWith(c,await mockClient(e,{wrongHolder:true,adminOnly:true}));assert.equal(r.status,'GREEN',r.reason);});

test('RED: wrong RPC chain cannot produce GREEN', async()=>{
 const e=await fixture(); const client=await mockClient(e);
 const r=await verifyWith(c,{...client,getChainId:async()=>1} as typeof client);
 assert.equal(r.status,'RED'); assert.match(r.reason,/Wrong chain/);
});
test('RED: reorg between snapshot and final guard is detected', async()=>{
 const e=await fixture(); const client=await mockClient(e); let blocks=0;
 const modified={...client,getBlock:async()=>({number:123n,timestamp:1000n,hash:'0x'+(++blocks===1?'a':'b').repeat(64)})} as unknown as typeof client;
 const r=await verifyWith(c,modified); assert.equal(r.status,'RED'); assert.match(r.reason,/Block changed/);
});
test('AMBER: unknown raw artifact bytes are unavailable, never GREEN', async()=>{
 const e=await fixture(); const bytes=toBytes('not written to the raw content store');
 e.core.cid=await bytesCid(bytes); e.core.buildHash=await sha256Hex(bytes); e.signature=await owner.signTypedData(typedApproval(e.core));
 const r=await verifyWith(c,await mockClient(e)); assert.equal(r.status,'AMBER'); assert.match(r.reason,/unavailable/);
});
test('RED: project ownership is still strict even when environment holder is informational', async()=>{
 const e=await fixture(); const client=await mockClient(e,{wrongHolder:true});
 const modified={...client,readContract:async(args:any)=>{
  const value=await client.readContract(args);
  return args.address===A.eth && args.functionName==='getState' ? {...(value as object),latestOwner:other.address}:value;
 }} as unknown as typeof client;
 const r=await verifyWith(c,modified); assert.equal(r.status,'RED'); assert.match(r.reason,/project owner/);
});
