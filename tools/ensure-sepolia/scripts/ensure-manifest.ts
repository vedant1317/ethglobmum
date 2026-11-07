import { recoverTypedDataAddress, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { canonicalCid, sha256Hex } from './content.js';
import { CHAIN_ID, same } from './config.js';
import { jcs, typedApproval, type Envelope, type Expected } from './release-approval.js';
export * from './release-approval.js';
const FIELDS = ['schemaVersion','chainId','name','projectName','parentRegistry','registry','parentResource','resource','resolver','cid','commit','buildHash','release','approver','issuedAt','validUntil','previousManifest'].sort().join(',');
function check(condition: unknown, why: string): asserts condition { if (!condition) throw new Error(why); }
export function parseEnvelope(bytes: Uint8Array): Envelope {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const value = JSON.parse(text);
  // Exact JCS round-trip also rejects duplicate object keys, extra whitespace, trailing data,
  // alternate number spellings and a UTF-8 BOM instead of silently accepting ambiguous bytes.
  check(jcs(value) === text, 'Manifest bytes must be canonical JSON (duplicate keys/ambiguous encodings rejected)');
  check(value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'core,signature', 'Unexpected envelope schema');
  return value as Envelope;
}
export async function validateManifest(envelope: Envelope, expected: Expected, currentCid: string, now: bigint, artifactBytes?: Uint8Array) {
  const c = envelope.core;
  check(c && typeof c === 'object' && Object.keys(c).sort().join(',') === FIELDS, 'Unexpected signed-core schema');
  check(c.schemaVersion === 1, 'Wrong schema version');
  for (const k of ['chainId','parentResource','resource','release','issuedAt','validUntil'] as const) check(typeof c[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(c[k]) && c[k].length <= 78, `Invalid ${k}`);
  check(c.chainId === String(expected.chainId) && expected.chainId === CHAIN_ID, 'Wrong chain context');
  check(c.name === expected.name && normalize(c.name) === c.name, 'Wrong name context');
  check(c.projectName === expected.projectName && normalize(c.projectName) === c.projectName, 'Wrong project context');
  for (const k of ['parentRegistry','registry','resolver'] as const) check(typeof c[k] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c[k]) && same(c[k], expected[k]), `Wrong ${k} context`);
  check(c.parentResource === expected.parentResource && c.resource === expected.resource, 'Wrong registry resource/version context');
  check(typeof c.approver === 'string' && same(c.approver, expected.owner), 'Untrusted self-declared approver');
  check(typeof c.cid === 'string' && c.cid === canonicalCid(c.cid), 'CID must use canonical CIDv1 base32');
  check(typeof c.commit === 'string' && (/^[0-9a-f]{40}$/.test(c.commit) || c.commit === 'LOCAL_FIXTURE_NO_GIT_COMMIT'), 'Expected full Git SHA or explicit local-fixture sentinel');
  check(typeof c.buildHash === 'string' && /^0x[0-9a-f]{64}$/.test(c.buildHash), 'Invalid sha256 build hash');
  check(BigInt(c.release) > 0n && BigInt(c.release) >= BigInt(expected.minRelease), 'Approval older than trusted release checkpoint');
  check(BigInt(c.issuedAt) <= now && BigInt(c.validUntil) > now && BigInt(c.validUntil) > BigInt(c.issuedAt), 'Expired or not-yet-valid approval');
  check(typeof c.previousManifest === 'string' && (c.previousManifest === '' || c.previousManifest === canonicalCid(c.previousManifest)), 'Invalid previous manifest CID');
  const sig = envelope.signature;
  check(typeof sig === 'string' && /^0x[0-9a-fA-F]{130}$/.test(sig), 'Malformed EOA signature');
  check(BigInt('0x' + sig.slice(66,130)) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n && ['1b','1c'].includes(sig.slice(130).toLowerCase()), 'Noncanonical EOA signature');
  const signer = await recoverTypedDataAddress({ ...typedApproval(c), signature: sig });
  check(same(signer, expected.owner), 'Invalid owner approval signature');
  check(c.cid === canonicalCid(currentCid), 'Signed artifact CID differs from ENS contenthash');
  if (artifactBytes) check(await sha256Hex(artifactBytes) === c.buildHash, 'Signed build hash differs from raw fixture bytes');
  return signer;
}
