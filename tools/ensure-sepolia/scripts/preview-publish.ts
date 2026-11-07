/**
 * Live Sepolia: point preview.ensure.eth at a pinned site + manifest.
 * Preview resolver only — never touches prod.
 *
 * Usage:
 *   tsx tools/ensure-sepolia/scripts/preview-publish.ts --site-cid <cid> --manifest-cid <cid>
 *   tsx tools/ensure-sepolia/scripts/preview-publish.ts --receipt receipt.json
 *
 * Env: CI_PRIVATE_KEY, SEPOLIA_RPC_URL (public endpoint; no API keys in the URL).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData,
  TransactionReceiptNotFoundError, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { B, BUILD_KEY, CHAIN_ID, loadConfig, same, isMain, fatal } from './config.js';
import { contenthash } from './content.js';
import { dnsEncode } from './names.js';

const LIVE_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const MAX_GAS_PRICE = 2_000_000_000n;

type Args = { siteCid: string; manifestCid: string; expectedContenthash?: Hex };

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--site-cid' || a === '--manifest-cid' || a === '--receipt' || a === '--expected-contenthash') {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      out[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
  }
  if (out.receipt) {
    const path = resolve(out.receipt);
    if (!existsSync(path)) throw new Error(`Receipt not found: ${path}`);
    const r = JSON.parse(readFileSync(path, 'utf8')) as { siteCid?: string; manifestCid?: string; contenthash?: Hex };
    if (!r.siteCid || !r.manifestCid) throw new Error('Receipt must include siteCid and manifestCid');
    return { siteCid: r.siteCid, manifestCid: r.manifestCid, expectedContenthash: r.contenthash };
  }
  if (!out['site-cid'] || !out['manifest-cid']) {
    throw new Error('Usage: --site-cid <cid> --manifest-cid <cid>  OR  --receipt receipt.json');
  }
  return {
    siteCid: out['site-cid'],
    manifestCid: out['manifest-cid'],
    expectedContenthash: out['expected-contenthash'] as Hex | undefined,
  };
}

function requireCiKey(): Hex {
  const key = process.env.CI_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set CI_PRIVATE_KEY to a 0x-prefixed 32-byte hex key');
  return key as Hex;
}

async function mined(client: ReturnType<typeof createPublicClient>, hash: Hex) {
  const end = Date.now() + 240_000;
  do {
    try { return await client.getTransactionReceipt({ hash }); }
    catch (e) { if (!(e instanceof TransactionReceiptNotFoundError)) throw e; }
    await delay(2000);
  } while (Date.now() < end);
  throw new Error(`Receipt unavailable after 240s: ${hash}`);
}

export async function publishPreview(args: Args) {
  const c = loadConfig();
  if (c.mode !== 'sepolia' || c.chainId !== CHAIN_ID) throw new Error('Expected live Sepolia deployments/sepolia.json');
  const account = privateKeyToAccount(requireCiKey());
  if (!same(account.address, c.ci)) throw new Error(`CI key address ${account.address} does not match deployments/sepolia.json ci`);

  if (same(c.previewResolver, c.prodResolver)) throw new Error('Unsafe shared prod/preview resolver');
  if (!same(c.previewName, 'preview.ensure.eth')) throw new Error(`Unexpected preview name: ${c.previewName}`);
  const target = c.previewResolver as Address;

  const client = createPublicClient({ chain: sepolia, transport: http(LIVE_RPC, { timeout: 45_000 }), cacheTime: 0 });
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Wrong chain: ${chainId}`);
  const version = await client.request({ method: 'web3_clientVersion' });
  if (String(version).toLowerCase().includes('anvil')) throw new Error('Refusing Anvil; live Sepolia only');

  const ch = contenthash(args.siteCid);
  if (args.expectedContenthash && !same(ch, args.expectedContenthash)) {
    throw new Error(`contenthash mismatch: got ${ch}, expected ${args.expectedContenthash}`);
  }

  const dns = dnsEncode(c.previewName);
  const calls = [
    encodeFunctionData({ abi: B.resolver, functionName: 'setContenthash', args: [dns, ch] }),
    encodeFunctionData({
      abi: B.resolver, functionName: 'setText',
      args: [dns, BUILD_KEY, 'ipfs://' + args.manifestCid],
    }),
  ];

  const blockNumber = (await client.getBlock()).number;
  console.log('simulating preview multicall at block', blockNumber.toString());
  await client.simulateContract({
    address: target, abi: B.resolver, functionName: 'multicall', args: [calls], account, blockNumber,
  });
  console.log('simulation PASS');

  const fees = await client.estimateFeesPerGas();
  if ((fees.maxFeePerGas ?? 0n) > MAX_GAS_PRICE) throw new Error('Gas price above 2 gwei modest-spend cap');
  const estimate = await client.estimateContractGas({
    address: target, abi: B.resolver, functionName: 'multicall', args: [calls], account, blockNumber,
  });
  const gas = (estimate * 120n) / 100n + 10_000n;
  const cost = gas * (fees.maxFeePerGas ?? 0n);
  const bal = await client.getBalance({ address: account.address, blockTag: 'pending' });
  if (bal < cost) throw new Error('CI balance too low for estimated gas');

  const wallet = createWalletClient({ chain: sepolia, account, transport: http(LIVE_RPC) });
  const hash = await wallet.writeContract({
    address: target, abi: B.resolver, functionName: 'multicall', args: [calls], gas, ...fees,
  });
  const explorer = `https://sepolia.etherscan.io/tx/${hash}`;
  console.log('SUBMITTED', explorer);

  const receipt = await mined(client, hash);
  if (receipt.status !== 'success') throw new Error(`Transaction reverted ${explorer}`);
  console.log('MINED block', receipt.blockNumber.toString(), 'gas', receipt.gasUsed.toString());

  return {
    hash, explorer, receipt, contenthash: ch,
    siteCid: args.siteCid, manifestCid: args.manifestCid,
    previewResolver: target, previewName: c.previewName,
  };
}

if (isMain(import.meta.url)) {
  publishPreview(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(JSON.stringify({
        hash: r.hash, explorer: r.explorer, blockNumber: r.receipt.blockNumber.toString(),
        status: r.receipt.status, contenthash: r.contenthash, siteCid: r.siteCid, manifestCid: r.manifestCid,
      }, null, 2));
    })
    .catch(fatal);
}
