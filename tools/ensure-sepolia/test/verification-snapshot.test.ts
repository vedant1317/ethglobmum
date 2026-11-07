import { test } from 'vitest';
import assert from 'node:assert/strict';
import { verifyWith, isSnapshotLag } from '../scripts/verify.js';
import { CHAIN_ID, type DeploymentConfig } from '../scripts/config.js';
const address = (digit: string) => ('0x' + digit.repeat(40)) as `0x${string}`;
const config: DeploymentConfig = { mode: 'sepolia', chainId: CHAIN_ID, forkBlock: 0, sourceCommit: 'unit-fixture', label: 'unit', projectName: 'unit.eth', prodName: 'prod.unit.eth', previewName: 'preview.unit.eth', registry: address('1'), prodResolver: address('2'), previewResolver: address('3'), owner: address('4'), ci: address('5'), projectResource: '1', prodResource: '2', minRelease: '0', history: [] };
for (const snapshot of [123n, undefined]) {
  test(snapshot === undefined ? 'Verifier default snapshot still selects the latest block once' : 'Verifier pins every read to an explicit post-receipt snapshot, never stale latest', async () => {
    const reads: bigint[] = []; let selected: unknown; let blockCalls = 0;
    const client = {
      getChainId: async () => CHAIN_ID,
      getBlock: async (args: unknown) => { selected = args; blockCalls++; return {number: snapshot ?? 456n, timestamp: 1000n, hash: '0x' + 'a'.repeat(64)}; },
      readContract: async (args: { blockNumber: bigint }) => { reads.push(args.blockNumber); throw new Error('offline-snapshot-sentinel'); },
    } as unknown as Parameters<typeof verifyWith>[1];
    const result = await verifyWith(config, client, 'prod', snapshot);
    assert.equal(blockCalls, 1);
    assert.deepEqual(selected, snapshot === undefined ? undefined : {blockNumber: snapshot});
    assert.equal(reads.length, 9); assert.ok(reads.every(b => b === (snapshot ?? 456n)));
    assert.equal(result.block, String(snapshot ?? 456n));
    assert.equal(result.reason, 'offline-snapshot-sentinel');
    assert.notEqual(result.status, 'GREEN');
  });
}

test('Snapshot retry recognizes header and block lag, not authority failures',()=>{assert.equal(isSnapshotLag('header not found'),true);assert.equal(isSnapshotLag('Details: block not found: 0xb84bb6'),true);assert.equal(isSnapshotLag('Invalid owner approval signature'),false);});
