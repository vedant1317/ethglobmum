/**
 * src/ensv2.js
 * ENSv2 (Sepolia) reads and writes, matching ENSure's protocol layer
 * (ensure-web/src/shared/core/ens.ts, ensdomains/contracts-v2 @ 07e55a05).
 *
 *   owner        → UniversalHelper.findExactOwner(dnsName)
 *   resolver     → UniversalResolver.findResolver(dnsName)
 *   contenthash  → UniversalResolver.resolve(dnsName, contenthash(node))
 *   publish      → PermissionedResolver.setContenthash(dnsName, 0xe301 + CIDv1)
 *
 * In ENSv2, owning a name and holding SET_CONTENTHASH on its resolver are separate
 * permissions, so write access is checked by simulating the call for that account.
 */

const { ethers } = require("ethers");

const ENSV2 = {
  universalResolver: process.env.ENSV2_UNIVERSAL_RESOLVER || "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  universalHelper:   process.env.ENSV2_UNIVERSAL_HELPER   || "0xd453e5bdb62cc3bea84341b1e306319c8ffd7dfe",
  ethRegistry:       process.env.ENSV2_ETH_REGISTRY       || "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
};

const ROLE_SET_CONTENTHASH = 1n << 8n;

const HELPER_ABI = ["function findExactOwner(bytes name) view returns (address)"];
const UNIVERSAL_RESOLVER_ABI = [
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
];
const RESOLVER_ABI = [
  "function setContenthash(bytes name, bytes hash)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
];

function getProvider() {
  const rpcUrl = process.env.ENS_RPC_URL || process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("ENS_RPC_URL or SEPOLIA_RPC_URL is required for ENSv2 lookups");
  return new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
}

function normalizeName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed.includes(".")) throw new Error(`Invalid ENS name: ${name}`);
  return ethers.ensNormalize(trimmed);
}

const dnsName = (name) => ethers.dnsEncode(normalizeName(name));

// ── CID → ENS contenthash (0xe301 = ipfs-ns, followed by binary CIDv1) ────────

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character in CID: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function cidToBytes(cid) {
  const value = (cid || "").trim();
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value)) {
    // CIDv0 (base58 sha2-256 multihash) → CIDv1 dag-pb
    const multihash = ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(value), 34));
    return Uint8Array.from([0x01, 0x70, ...multihash]);
  }
  if (value.startsWith("b")) return base32Decode(value.slice(1).toLowerCase());
  throw new Error(`Unsupported CID encoding: ${value}`);
}

function encodeIpfsContenthash(cid) {
  return ethers.hexlify(Uint8Array.from([0xe3, 0x01, ...cidToBytes(cid)]));
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Current ENSv2 owner of a name, or the zero address when it is not registered. */
async function findOwner(name, provider = getProvider()) {
  const helper = new ethers.Contract(ENSV2.universalHelper, HELPER_ABI, provider);
  return helper.findExactOwner(dnsName(name));
}

/** The resolver that serves a name, or the zero address. */
async function findResolver(name, provider = getProvider()) {
  const ur = new ethers.Contract(ENSV2.universalResolver, UNIVERSAL_RESOLVER_ABI, provider);
  try {
    const [resolver] = await ur.findResolver(dnsName(name));
    return resolver;
  } catch {
    return ethers.ZeroAddress;
  }
}

/** Current contenthash bytes ("0x" when unset or unresolvable). */
async function readContenthash(name, provider = getProvider()) {
  const ur = new ethers.Contract(ENSV2.universalResolver, UNIVERSAL_RESOLVER_ABI, provider);
  const iface = new ethers.Interface(RESOLVER_ABI);
  try {
    const [data] = await ur.resolve(dnsName(name), iface.encodeFunctionData("contenthash", [ethers.namehash(normalizeName(name))]));
    return iface.decodeFunctionResult("contenthash", data)[0];
  } catch {
    return "0x";
  }
}

async function isOwner(name, walletAddress) {
  const owner = await findOwner(name);
  return owner !== ethers.ZeroAddress && owner.toLowerCase() === walletAddress.toLowerCase();
}

/** True when `account` can call setContenthash for `name` on its resolver (simulated, no tx). */
async function canSetContenthash(name, account, cid = "bafkqaaa", provider = getProvider()) {
  const resolverAddress = await findResolver(name, provider);
  if (resolverAddress === ethers.ZeroAddress) return { allowed: false, resolver: resolverAddress, reason: "No resolver is set for this name" };
  const resolver = new ethers.Contract(resolverAddress, RESOLVER_ABI, provider);
  try {
    await resolver.setContenthash.staticCall(dnsName(name), encodeIpfsContenthash(cid), { from: account });
    return { allowed: true, resolver: resolverAddress };
  } catch (err) {
    return { allowed: false, resolver: resolverAddress, reason: err.shortMessage || err.message };
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Points `name` at `ipfs://cid` from the backend signer. Caller must check canSetContenthash first. */
async function setContenthash(name, cid, signer, log = console.log) {
  const resolverAddress = await findResolver(name, signer.provider);
  if (resolverAddress === ethers.ZeroAddress) throw new Error(`${name} has no ENSv2 resolver`);
  const resolver = new ethers.Contract(resolverAddress, RESOLVER_ABI, signer);
  const nonce = await signer.provider.getTransactionCount(signer.address, "pending");
  log(`  🪪 ENSv2 resolver ${resolverAddress}.setContenthash(${name}) nonce=${nonce}`);
  const tx = await resolver.setContenthash(dnsName(name), encodeIpfsContenthash(cid), { nonce });
  log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`  ✅ ${name} → ipfs://${cid} (block ${receipt.blockNumber})`);
  return { txHash: tx.hash, resolver: resolverAddress, blockNumber: receipt.blockNumber };
}

module.exports = {
  ENSV2,
  ROLE_SET_CONTENTHASH,
  dnsName,
  encodeIpfsContenthash,
  findOwner,
  findResolver,
  readContenthash,
  isOwner,
  canSetContenthash,
  setContenthash,
};
