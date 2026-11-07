import { createPublicClient,http,decodeAbiParameters,encodeFunctionData,namehash,recoverTypedDataAddress,bytesToHex,keccak256,toBytes,type Address,type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { jcs,typedApproval,type Core,type Envelope } from './release-approval.js';
import { buildPromotion,resolverAbi,profileAbi,RECORD_KEYS,INLINE_APPROVAL_KEY,bytesCid } from './owner-promote-shared.js';
import { dnsEncode } from './names.js';
declare const __PAGE_DATA__: {config:{owner:Address;prodResolver:Address;registry:Address;prodName:string;projectName:string;projectResource:string;prodResource:string;sourceCommit:string;minRelease:string};protocol:{eth:Address;helper:Address};rpc:string;proposal:Core;artifactBase64:string;currentHash:Hex;records:Record<string,string>;environmentRegistrationHolder:Address};
const D=__PAGE_DATA__,c=D.config;
const client=createPublicClient({chain:sepolia,transport:http(D.rpc,{timeout:30_000,retryCount:1}),cacheTime:0});
const el=(id:string)=>document.getElementById(id)!;
const button=(id:string)=>el(id) as HTMLButtonElement;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const message=(text:string)=>{el('status').textContent=text;};
const out=(value:unknown)=>JSON.stringify(value,(_,x)=>typeof x==='bigint'?x.toString():x,2);
let account:Address|undefined,envelope:Envelope|undefined,payload:Awaited<ReturnType<typeof buildPromotion>>|undefined,submitted=false;
const storageKey='ensure-owner-promote-'+c.prodResolver+'-'+D.proposal.previousManifest;
const provider=()=>{const root=(window as any).ethereum;const p=root?.providers?.find((p:any)=>p.isMetaMask)??root;if(!p)throw new Error('Open this page in a desktop browser with MetaMask installed, or inside the MetaMask browser.');return p;};
const req=(method:string,params:unknown[]=[])=>provider().request({method,params});
function reset(){envelope=undefined;payload=undefined;button('sign').disabled=!account||submitted;button('promote').disabled=true;button('download').disabled=true;}
async function ensureWallet(){const chain=await req('eth_chainId');if(chain!=='0xaa36a7')throw new Error('Switch MetaMask to Sepolia first.');const accounts=await req('eth_accounts');if(!accounts[0]||!eq(accounts[0],c.owner))throw new Error('Selected wallet is not the configured project owner: '+c.owner);account=accounts[0];}
async function recordsAt(blockNumber:bigint){
 const resolve=async(fn:'contenthash'|'text',key?:string)=>client.readContract({address:c.prodResolver,abi:resolverAbi,functionName:'resolve',args:[dnsEncode(c.prodName),encodeFunctionData({abi:profileAbi,functionName:fn,args:fn==='text'?[namehash(c.prodName),key!]:[namehash(c.prodName)]})],blockNumber});
 const hash=decodeAbiParameters([{type:'bytes'}],await resolve('contenthash'))[0];
 const records:Record<string,string>={};for(const key of [...RECORD_KEYS,'ensure.build'])records[key]=decodeAbiParameters([{type:'string'}],await resolve('text',key))[0];
 return {hash,records};
}
async function checkContext(blockNumber:bigint){
 const stateAbi=[{type:'function',name:'getState',stateMutability:'view',inputs:[{name:'labelId',type:'uint256'}],outputs:[{type:'tuple',components:[{name:'status',type:'uint8'},{name:'expiry',type:'uint64'},{name:'latestOwner',type:'address'},{name:'tokenId',type:'uint256'},{name:'resource',type:'uint256'}]}]}] as const;
 // ABI comes from the same deployment metadata; exact tuple layout is checked in preparation tests.
 const project=await client.readContract({address:D.protocol.eth,abi:stateAbi,functionName:'getState',args:[BigInt(keccak256(toBytes(c.projectName.split('.')[0])))],blockNumber});
 const prod=await client.readContract({address:c.registry,abi:stateAbi,functionName:'getState',args:[BigInt(keccak256(toBytes('prod')))],blockNumber});
 const registryAbi=[{type:'function',name:'getResolver',stateMutability:'view',inputs:[{type:'string',name:'label'}],outputs:[{type:'address'}]}] as const;
 const resolver=await client.readContract({address:c.registry,abi:registryAbi,functionName:'getResolver',args:['prod'],blockNumber});
 const block=await client.getBlock({blockNumber});
 if(project.status!==2||prod.status!==2||project.expiry<=block.timestamp||prod.expiry<=block.timestamp||!eq(project.latestOwner,c.owner)||project.resource.toString()!==c.projectResource||prod.resource.toString()!==c.prodResource||!eq(resolver,c.prodResolver))throw new Error('Project ownership, active registration, resource version, or resolver routing changed. Stop and rebuild this page.');
 const s=256n,t=16n;
 for(const [bits,key] of [[s,null],...RECORD_KEYS.map(key=>[t,key])] as [bigint,string|null][]){
  const read=(role:bigint)=>key===null?client.readContract({address:c.prodResolver,abi:resolverAbi,functionName:'hasRootRoles',args:[role,c.owner],blockNumber}):client.readContract({address:c.prodResolver,abi:resolverAbi,functionName:'hasRoles',args:[BigInt(keccak256(toBytes(key))),role,c.owner],blockNumber});
  if(!await read(bits)&&!await read(bits<<128n))throw new Error('Owner lacks required resolver writer/admin authority');
 }
}
async function refresh(){const b=await client.getBlock();const v=await recordsAt(b.number);el('current').textContent=out({block:b.number,contenthash:v.hash,...v.records});return {block:b,...v};}
function showTx(hash:Hex){const a=document.createElement('a');a.href='https://sepolia.etherscan.io/tx/'+hash;a.textContent='View transaction '+hash;a.target='_blank';a.rel='noopener noreferrer';el('tx').replaceChildren(a);}
async function verifyBrowser(){message('Checking current chain records, manifest commitment, signature, CID, bytes and authority…');
 if(await client.getChainId()!==11155111)throw new Error('Wrong chain');
 const {block,hash,records}=await refresh();await checkContext(block.number);
 if(!records[INLINE_APPROVAL_KEY])throw new Error('No new owner-signed inline approval yet. Sign and promote first; full verifier remains RED until the transaction succeeds.');
 const bytes=new TextEncoder().encode(records[INLINE_APPROVAL_KEY]);const e:Envelope=JSON.parse(records[INLINE_APPROVAL_KEY]);
 if(jcs(e)!==records[INLINE_APPROVAL_KEY])throw new Error('Manifest is not canonical JSON');
 const manifestCid=await bytesCid(bytes);
 if(records['ensure.release']!=='ipfs://'+manifestCid||records['ensure.manifest']!==records['ensure.release'])throw new Error('Manifest pointer/bytes mismatch');
 const expected={...D.proposal,release:e.core.release,issuedAt:e.core.issuedAt,validUntil:e.core.validUntil};
 if(jcs(expected)!==jcs(e.core))throw new Error('Signed manifest context differs from this prepared release');
 if(!eq(await recoverTypedDataAddress({...typedApproval(e.core),signature:e.signature}),c.owner))throw new Error('Invalid configured-owner signature');
 if(BigInt(e.core.issuedAt)>block.timestamp||BigInt(e.core.validUntil)<=block.timestamp||BigInt(e.core.release)<BigInt(c.minRelease))throw new Error('Approval expired, future-dated, or below trusted checkpoint');
 const artifact=Uint8Array.from(atob(D.artifactBase64),x=>x.charCodeAt(0));
 if(await bytesCid(artifact)!==e.core.cid)throw new Error('Fixture CID mismatch');
 const digest=bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',artifact)));
 if(digest!==e.core.buildHash||hash!==(await buildPromotion(e)).contenthash)throw new Error('Artifact contenthash/build hash mismatch');
 message('PASS — browser checks match the owner-approved fixture at block '+block.number+'.\nRun the full independent verifier for authoritative GREEN:\npnpm verify:sepolia prod');
}
async function run(fn:()=>Promise<void>){try{await fn();}catch(e){message('STOP — '+(e instanceof Error?e.message:String(e)));}}
button('connect').onclick=()=>run(async()=>{
 await req('eth_requestAccounts');
 if(await req('eth_chainId')!=='0xaa36a7'){try{await req('wallet_switchEthereumChain',[{chainId:'0xaa36a7'}]);}catch(e){if((e as any).code!==4902)throw e;await req('wallet_addEthereumChain',[{chainId:'0xaa36a7',chainName:'Sepolia',nativeCurrency:{name:'Sepolia Ether',symbol:'ETH',decimals:18},rpcUrls:[D.rpc],blockExplorerUrls:['https://sepolia.etherscan.io']}]);}}
 await ensureWallet();reset();el('account').textContent='Connected owner: '+account;
 provider().on?.('accountsChanged',()=>{account=undefined;reset();el('account').textContent='Account changed — reconnect the configured owner.';});
 provider().on?.('chainChanged',()=>{account=undefined;reset();el('account').textContent='Network changed — reconnect on Sepolia.';});
 message(submitted?'A transaction for this prepared release was already submitted. Inspect its link or run browser checks; this page will not resend.':'Owner connected. Review, then click Sign release approval. No transaction has been sent.');
});
button('sign').onclick=()=>run(async()=>{
 if(submitted)throw new Error('Inspect the already-submitted transaction; this page will not resend.');
 await ensureWallet();reset();const {block,hash,records}=await refresh();await checkContext(block.number);
 if(hash!==D.currentHash||records['ensure.manifest']!==D.records['ensure.manifest']||records['ensure.release']!==D.records['ensure.release'])throw new Error('Live release changed after page preparation. Stop and rebuild; no overwrite attempted.');
 const core:Core={...D.proposal,issuedAt:block.timestamp.toString(),validUntil:(block.timestamp+172800n).toString()};
 const typed=typedApproval(core);const data={...typed,types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'}],...typed.types}};
 el('typed').textContent=out({core,typedData:data,expiryIST:new Date(Number(core.validUntil)*1000).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST'});
 const signature=await req('eth_signTypedData_v4',[account,JSON.stringify(data)]) as Hex;
 await ensureWallet();if(!eq(await recoverTypedDataAddress({...typed,signature}),c.owner))throw new Error('Returned signature is not from the configured owner');
 envelope={core,signature};payload=await buildPromotion(envelope);
 // A successful call is ONLY write authorization/ABI simulation, not a submitted transaction.
 await client.call({account:c.owner,to:c.prodResolver,data:payload.data});
 el('calldata').textContent=out({chainId:11155111,to:c.prodResolver,value:'0x0',manifestCid:payload.manifestCid,data:payload.data});
 button('promote').disabled=false;button('download').disabled=false;
 message('Signature checked; resolver eth_call simulation passed. Click Promote for ONE MetaMask transaction.');
});
button('promote').onclick=()=>run(async()=>{
 if(!payload||!envelope)throw new Error('Sign first');if(submitted)throw new Error('A transaction was already submitted on this page. Inspect it instead of resending.');
 await ensureWallet();const {block,hash,records}=await refresh();await checkContext(block.number);
 if(hash!==D.currentHash||records['ensure.manifest']!==D.records['ensure.manifest'])throw new Error('Current release changed; stop and rebuild.');
 if(BigInt(envelope.core.validUntil)<=block.timestamp)throw new Error('Signature expired — sign a fresh approval');
 const gas=await client.estimateGas({account:c.owner,to:c.prodResolver,data:payload.data});
 const price=await client.getGasPrice();if(gas*price>5000000000000000n)throw new Error('Estimated gas cost exceeds 0.005 Sepolia ETH cap; stop.');
 button('promote').disabled=true;
 const tx=await req('eth_sendTransaction',[{from:account,to:c.prodResolver,data:payload.data,value:'0x0',gas:'0x'+(gas*120n/100n+10000n).toString(16)}]) as Hex;
 submitted=true;button('sign').disabled=true;showTx(tx);try{localStorage.setItem(storageKey,tx);}catch{}
 message('Transaction submitted. Waiting for a receipt; do not resend.');
 const receipt=await client.waitForTransactionReceipt({hash:tx,confirmations:1,timeout:240_000});
 if(receipt.status!=='success')throw new Error('Transaction reverted. Inspect the link; no retry was sent.');
 await verifyBrowser();
});
button('download').onclick=()=>{if(!payload)return;const url=URL.createObjectURL(new Blob([payload.manifest],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ensure-release-'+envelope!.core.release+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
button('verify').onclick=()=>run(verifyBrowser);
el('proposal').textContent=out({name:c.prodName,owner:c.owner,resolver:c.prodResolver,artifactCid:D.proposal.cid,buildHash:D.proposal.buildHash,artifactCommit:D.proposal.commit,protocolSourceCommit:c.sourceCommit,release:D.proposal.release,expiry:'Fresh chain timestamp + 48 hours at signing'});
el('holder').textContent='Environment token holder (informational only): '+D.environmentRegistrationHolder+'. Authority is the configured project owner signature plus resolver roles.';
try{const prior=localStorage.getItem(storageKey);if(prior){submitted=true;showTx(prior as Hex);}}catch{}
void run(async()=>{await refresh();});
