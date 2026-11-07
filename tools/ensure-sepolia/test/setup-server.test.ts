import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { keccak256, toBytes } from 'viem';
import { REPO_ROOT } from '../scripts/config.js';
// Isolated fake processes: these tests never start Docker, hit an RPC, or send a transaction.
function sandbox() {
 const dir=mkdtempSync(resolve(tmpdir(),'ensure-bootstrap-test-'));
 mkdirSync(resolve(dir,'bin')); mkdirSync(resolve(dir,'deployments'));
 copyFileSync(resolve(REPO_ROOT,'.env.example'),resolve(dir,'.env.example'));
 copyFileSync(resolve(REPO_ROOT,'setup-server.sh'),resolve(dir,'setup-server.sh'));
 writeFileSync(resolve(dir,'docker-compose.yml'),'services: {}\n');
 writeFileSync(resolve(dir,'deployments/sepolia.json'),'{}');
 symlinkSync(resolve(REPO_ROOT,'node_modules'),resolve(dir,'node_modules'),'dir');
 writeFileSync(resolve(dir,'bin/docker'),'#!/usr/bin/env bash\nexit 0\n',{mode:0o755});
 writeFileSync(resolve(dir,'bin/pnpm'),`#!/usr/bin/env bash
if [[ "$1" == install ]]; then exit 0; fi
if [[ "$TEST_SETUP_FAIL" == 1 ]]; then
 printf 'RPC failure %s %s\\n' "$PUBLISHER_PRIVATE_KEY" "$PINATA_JWT" >&2
 exit 1
fi
node --input-type=module -e '
import { writeFileSync } from "node:fs";
writeFileSync("deployments/sepolia.json",JSON.stringify({platform:{name:"fixture.eth",registry:"0x"+"1".repeat(40),resolver:"0x"+"2".repeat(40)}}));
'
`,{mode:0o755});
 return dir;
}
const key=keccak256(toBytes('ENSure throwaway bootstrap unit-test account'));
const token='test-only-placeholder-not-a-live-token';
function run(dir:string, fail=false) {
 return spawnSync('bash',['-x','setup-server.sh'],{
  cwd:dir,encoding:'utf8',timeout:15_000,
  input:['',key,token,'','fixture.eth','y',''].join('\n'),
  env:{...process.env,PATH:resolve(dir,'bin')+':'+process.env.PATH,TEST_SETUP_FAIL:fail?'1':'0'},
 });
}
test('bootstrap preserves template keys, writes mode 600, clears setup key, never prints secrets',()=>{
 const dir=sandbox(); try {
  const result=run(dir); assert.equal(result.status,0);
  const text=readFileSync(resolve(dir,'.env'),'utf8');
  const output=result.stdout+result.stderr;
  assert.ok(!output.includes(key),'no key in output'); assert.ok(!output.includes(token),'no token in output');
  assert.equal(statSync(resolve(dir,'.env')).mode & 0o777,0o600);
  assert.match(text,/^SESSION_SECRET="[0-9a-f]{64}"$/m);
  assert.match(text,/^SETUP_PRIVATE_KEY=""$/m);
  assert.match(text,/^PLATFORM_NAME="fixture.eth"$/m);
  for(const line of readFileSync(resolve(dir,'.env.example'),'utf8').split('\n')) {
   const field=/^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
   if(field) assert.ok(text.includes(field+'='),'template key retained: '+field);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('bootstrap failure suppresses secret-bearing RPC errors and deletes temporary logs',()=>{
 const dir=sandbox(); try {
  const result=run(dir,true); assert.notEqual(result.status,0);
  const output=result.stdout+result.stderr;
  assert.ok(!output.includes(key),'no key in failure output'); assert.ok(!output.includes(token),'no token in failure output');
  assert.match(output,/setup-ens failed/);
  assert.match(readFileSync(resolve(dir,'.env'),'utf8'),/^SETUP_PRIVATE_KEY=""$/m);
  assert.ok(readdirSync(dir).every(name=>!name.startsWith('.env.setup.')&&!name.startsWith('.env.tmp.')));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('bootstrap refuses an environment symlink without writing its target',()=>{
 const dir=sandbox(); try {
  writeFileSync(resolve(dir,'target'),'unchanged'); symlinkSync('target',resolve(dir,'.env'));
  const result=run(dir); assert.notEqual(result.status,0);
  assert.equal(readFileSync(resolve(dir,'target'),'utf8'),'unchanged');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
