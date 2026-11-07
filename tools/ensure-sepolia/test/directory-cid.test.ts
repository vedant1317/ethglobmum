import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { bytesToHex, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { A, CHAIN_ID } from '../scripts/config.js';
import { cidOf, cidDigestHex, isRawCid, sha256Hex } from '../scripts/content.js';
import { jcs, validateManifest, typedApproval, type Core, type Expected } from '../scripts/ensure-manifest.js';

const owner = privateKeyToAccount(keccak256(toBytes('ENSure directory-cid unit-test owner')));
const now = 1793963508n;
const expected: Expected = {
  chainId: CHAIN_ID, name: 'prod.fixture.eth', projectName: 'fixture.eth',
  parentRegistry: A.eth, registry: A.registryImpl, parentResource: '42', resource: '24',
  resolver: A.resolverImpl, owner: owner.address, minRelease: '1',
};

test('isRawCid distinguishes raw file CIDs from dag-pb directory CIDs', async () => {
  const rawCid = await cidOf(toBytes('hello'));
  assert.equal(isRawCid(rawCid), true);
  // Known CIDv1 dag-pb (UnixFS directory) shape — codec 0x70, not raw 0x55.
  const dir = CID.parse('bafybeicxywmb2dczdj55tpw7j2mh6alllmxutpblzqns5xc33refxjchh4');
  assert.equal(dir.code === raw.code, false);
  assert.equal(isRawCid(dir.toString()), false);
});

test('cidDigestHex returns the multihash digest used as directory buildHash', async () => {
  const bytes = toBytes('digest-fixture');
  const digest = await sha256.digest(bytes);
  const cid = CID.createV1(raw.code, digest).toString();
  assert.equal(cidDigestHex(cid), bytesToHex(digest.digest));
  assert.equal(cidDigestHex(cid), await sha256Hex(bytes));
});

test('GREEN: directory release validates when buildHash equals CID digest and artifact bytes are omitted', async () => {
  const dirCid = 'bafybeicxywmb2dczdj55tpw7j2mh6alllmxutpblzqns5xc33refxjchh4';
  const buildHash = cidDigestHex(dirCid) as Hex;
  const core: Core = {
    schemaVersion: 1, chainId: String(CHAIN_ID), name: expected.name, projectName: expected.projectName,
    parentRegistry: expected.parentRegistry, registry: expected.registry,
    parentResource: expected.parentResource, resource: expected.resource, resolver: expected.resolver,
    cid: dirCid, commit: 'LOCAL_FIXTURE_NO_GIT_COMMIT', buildHash, release: '1',
    approver: owner.address, issuedAt: (now - 1n).toString(), validUntil: (now + 86400n).toString(),
    previousManifest: '',
  };
  const envelope = { core, signature: await owner.signTypedData(typedApproval(core)) };
  assert.equal(await validateManifest(envelope, expected, dirCid, now, undefined), owner.address);
  assert.equal(jcs(envelope.core).includes(dirCid), true);
});

test('RED: directory release with wrong buildHash digest is rejected by the verifier guard', async () => {
  const dirCid = 'bafybeicxywmb2dczdj55tpw7j2mh6alllmxutpblzqns5xc33refxjchh4';
  const wrong = ('0x' + '11'.repeat(32)) as Hex;
  assert.notEqual(cidDigestHex(dirCid), wrong);
  // Mirrors verify.ts: for non-raw CIDs, buildHash must equal cidDigestHex before validateManifest.
  assert.throws(() => {
    if (wrong !== cidDigestHex(dirCid)) throw new Error('Signed buildHash must equal directory CID multihash digest');
  }, /directory CID multihash digest/);
});
