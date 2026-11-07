// Read-only verification; no wallet/key is loaded and no transaction can be sent.
import { setTimeout as delay } from 'node:timers/promises';
import { verifyWith, isSnapshotLag } from './verify.js';
import { client } from './clients.js';
import { isMain, fatal, loadConfig } from './config.js';
export async function verifyLive(target: 'prod'|'preview' = 'prod') {
 const c = loadConfig();
 if(c.mode !== 'sepolia') throw new Error('Expected live Sepolia deployment metadata');
 const snapshot = await client.getBlock();
 for(let attempt=0;;attempt++) {
  const r = await verifyWith(c, client, target, snapshot.number);
  if(r.status !== 'AMBER' || !isSnapshotLag(r.reason) || attempt >= 5) return r;
  await delay(2000*(attempt+1)); // Retry only lagging snapshot reads, never writes.
 }
}
if(isMain(import.meta.url)) {
 const target=process.argv[2]??'prod';
 if(target !== 'prod' && target !== 'preview') fatal(new Error('Usage: verify-sepolia.ts [prod|preview]'));
 else verifyLive(target).then(r=>{console.log(JSON.stringify(r,null,2)); process.exitCode=r.status==='GREEN'?0:r.status==='RED'?2:3;}).catch(fatal);
}
