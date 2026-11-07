// Run only AFTER explicit approval to publish this exact public signing page.
// Never emits request headers, raw API errors, or environment values.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {CID} from 'multiformats/cid';
import {ROOT} from './config.js';
const html=readFileSync(resolve(ROOT,'owner-promote/index.html'));
const gateway=(process.env.PINATA_GATEWAY??'https://ipfs.io').replace(/\/$/,'')+'/ipfs/';
const sha256=createHash('sha256').update(html).digest('hex');
if(!process.argv.includes('--publish')){
 console.log(JSON.stringify({status:'DRY_RUN_NO_UPLOAD_NO_CREDENTIAL_READ',file:'owner-promote/index.html',bytes:html.length,sha256,destination:'Pinata public IPFS, ENSure owner signing page',requiredApproval:'Publish this signing HTML publicly to our Pinata account.'},null,2));
}else{
 try{
  const jwt=process.env.PINATA_JWT;
  if(!jwt)throw new Error('MISSING_CONFIG');
  const text=html.toString('utf8');
  if(text.includes(jwt)||/PRIVATE_KEY|BEGIN PRIVATE KEY|PINATA_JWT/.test(text))throw new Error('PUBLIC_FILE_FAILED_SECRET_CHECK');
  const form=new FormData();
  form.append('file',new File([html],'index.html',{type:'text/html'}));
  form.append('pinataOptions',JSON.stringify({cidVersion:1}));
  form.append('pinataMetadata',JSON.stringify({name:'ENSure — Owner Promote'}));
  const response=await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS',{method:'POST',headers:{Authorization:'Bearer '+jwt},body:form,signal:AbortSignal.timeout(90_000)});
  if(!response.ok)throw new Error('UPLOAD_HTTP_'+response.status);
  const result=await response.json() as {IpfsHash?:string};
  if(!result.IpfsHash)throw new Error('UPLOAD_RESPONSE_MISSING_CID');
  const cid=CID.parse(result.IpfsHash).toV1().toString();
  const url=gateway+cid;
  writeFileSync(resolve(ROOT,'evidence/owner-promote-publication.json'),JSON.stringify({status:'UPLOADED_GATEWAY_CHECK_PENDING',cid,url,bytes:html.length,sha256},null,2)+'\n');
  // No retry on ambiguous errors: an upload may have completed.
  const served=await fetch(url,{signal:AbortSignal.timeout(90_000)});
  if(!served.ok)throw new Error('GATEWAY_HTTP_'+served.status);
  const bytes=Buffer.from(await served.arrayBuffer());
  if(!bytes.equals(html))throw new Error('GATEWAY_BYTES_MISMATCH');
  const evidence={status:'PUBLISHED_AND_GATEWAY_BYTES_MATCH',cid,url,bytes:html.length,sha256,contentType:served.headers.get('content-type'),publishedAtIST:new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium'}).format(new Date())+' IST'};
  writeFileSync(resolve(ROOT,'evidence/owner-promote-publication.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
 }catch(error){
  const code=error instanceof Error&&/^(MISSING_CONFIG|PUBLIC_FILE_FAILED_SECRET_CHECK|UPLOAD_HTTP_\d+|UPLOAD_RESPONSE_MISSING_CID|GATEWAY_HTTP_\d+|GATEWAY_BYTES_MISMATCH)$/.test(error.message)?error.message:'UPLOAD_OR_GATEWAY_FAILED_CHECK_ACCOUNT_BEFORE_RETRY';
  console.error(code);process.exitCode=1;
 }
}
