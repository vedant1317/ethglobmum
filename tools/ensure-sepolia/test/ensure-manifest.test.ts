import { test } from 'vitest';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, type Hex } from 'viem';
import { A, CHAIN_ID } from '../scripts/config.js';
import { cidOf, contenthash, cidFromContenthash, sha256Hex } from '../scripts/content.js';
import { jcs, parseEnvelope, validateManifest, typedApproval, type Core, type Expected, type Envelope } from '../scripts/ensure-manifest.js';
const owner = privateKeyToAccount(keccak256(toBytes('ENSure isolated manifest unit-test owner')));
const attacker = privateKeyToAccount(keccak256(toBytes('ENSure isolated manifest unit-test attacker')));
const bytes = toBytes('unit fixture A'), now = 1793963508n;
const expected: Expected = { chainId: CHAIN_ID, name: 'prod.fixture.eth', projectName: 'fixture.eth', parentRegistry: A.eth, registry: A.registryImpl, parentResource: '42', resource: '24', resolver: A.resolverImpl, owner: owner.address, minRelease: '1' };
async function fixture() {
  const core: Core = { schemaVersion: 1, chainId: String(CHAIN_ID), name: expected.name, projectName: expected.projectName, parentRegistry: expected.parentRegistry, registry: expected.registry, parentResource: expected.parentResource, resource: expected.resource, resolver: expected.resolver, cid: await cidOf(bytes), commit: 'LOCAL_FIXTURE_NO_GIT_COMMIT', buildHash: await sha256Hex(bytes), release: '1', approver: owner.address, issuedAt: (now-1n).toString(), validUntil: (now+86400n).toString(), previousManifest: '' };
  return { core, signature: await owner.signTypedData(typedApproval(core)) };
}
const verify = (e: Envelope, cid = e.core.cid, time = now, context = expected) => validateManifest(e,context,cid,time,bytes);
test('GREEN: canonical signed raw fixture and ENSIP-7 round trip', async () => {
  const e = await fixture(); const parsed = parseEnvelope(toBytes(jcs(e)));
  assert.equal(await verify(parsed),owner.address); assert.equal(cidFromContenthash(contenthash(e.core.cid)),e.core.cid);
});
test('RED: tampered signed core', async () => { const e=await fixture();e.core.commit='a'.repeat(40);await assert.rejects(verify(e),/signature/); });
test('RED: wrong signer cannot claim the trusted owner', async () => { const e=await fixture();e.signature=await attacker.signTypedData(typedApproval(e.core));await assert.rejects(verify(e),/signature/); });
test('RED: manifest approver cannot bootstrap trust', async () => { const e=await fixture();e.core.approver=attacker.address;e.signature=await attacker.signTypedData(typedApproval(e.core));await assert.rejects(verify(e),/approver/); });
test('RED: wrong chain', async () => { const e=await fixture();e.core.chainId='1';await assert.rejects(verify(e),/chain/); });
test('RED: wrong name', async () => { const e=await fixture();e.core.name='preview.fixture.eth';await assert.rejects(verify(e),/name/); });
test('RED: wrong resolver', async () => { const e=await fixture();e.core.resolver=A.eth;await assert.rejects(verify(e),/resolver/); });
test('RED: stale re-registration resource', async () => { const e=await fixture();e.core.resource='25';await assert.rejects(verify(e),/resource/); });
test('RED: ancestor re-registration resource', async () => { const e=await fixture();e.core.parentResource='43';await assert.rejects(verify(e),/resource/); });
test('RED: current ENS CID mismatch', async () => { const e=await fixture();await assert.rejects(verify(e,await cidOf(toBytes('different'))),/CID differs/); });
test('RED: wrong signed raw-file buildHash', async () => { const e=await fixture();e.core.buildHash=('0x'+'00'.repeat(32)) as Hex;e.signature=await owner.signTypedData(typedApproval(e.core));await assert.rejects(verify(e),/build hash/); });
test('RED: expired approval', async () => { const e=await fixture();await assert.rejects(verify(e,e.core.cid,now+86401n),/Expired/); });
test('RED: future-dated approval', async () => { const e=await fixture();e.core.issuedAt=(now+1n).toString();await assert.rejects(verify(e),/not-yet-valid/); });
test('RED: older than independently trusted checkpoint', async () => { const e=await fixture();await assert.rejects(verify(e,e.core.cid,now,{...expected,minRelease:'2'}),/checkpoint/); });
test('RED: malformed signature', async () => { const e=await fixture();e.signature='0x00';await assert.rejects(verify(e),/Malformed/); });
test('RED: duplicate JSON keys and noncanonical whitespace', async () => { const e=await fixture();assert.throws(()=>parseEnvelope(toBytes('{"core":{},"core":'+jcs(e.core)+',"signature":"'+e.signature+'"}')),/canonical/);assert.throws(()=>parseEnvelope(toBytes(JSON.stringify(e,null,2))),/canonical/); });
test('RED: unknown core fields', async () => { const e=await fixture();(e.core as unknown as Record<string,unknown>).unexpected=true;await assert.rejects(verify(e),/schema/); });

test('RED: other application domain signatures cannot be replayed as ENSure approval', async () => {
  const e=await fixture(); const typed=typedApproval(e.core);
  // A distinct application domain must never authorize this application.
  e.signature=await owner.signTypedData({...typed,domain:{...typed.domain,name:'OtherApp'}});
  await assert.rejects(verify(e),/signature/);
});
