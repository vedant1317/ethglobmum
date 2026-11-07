// ENSv2 addresses, roles, ABIs and encoding. Verified against ensdomains/contracts-v2 @ 07e55a05.
import { CID } from "multiformats/cid";
import { concat, encodeFunctionData, decodeFunctionResult, hexToBytes, keccak256, namehash, parseAbi, toHex, type Address, type Hex } from "viem";
import { normalize, packetToBytes } from "viem/ens";

export const SEPOLIA = {
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  universalHelper: "0xd453e5bdb62cc3bea84341b1e306319c8ffd7dfe",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  ethRegistrar: "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
  verifiableFactory: "0xda70306c98e97ece36f997a21368e53298572991",
  resolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  registryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
} as const satisfies Record<string, Address>;

const admin = (r: bigint) => r << 128n;
export const withAdmin = (...roles: bigint[]) => roles.reduce((a, r) => a | r | admin(r), 0n);

export const REGISTRY_ROLES = {
  REGISTRAR: 1n << 0n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  UPGRADE: 1n << 124n,
};
export const RESOLVER_ROLES = {
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  LINK: 1n << 28n,
  UPGRADE: 1n << 124n,
};

export const registryAbi = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function setResolver(uint256 anyId, address resolver)",
  "function setParent(address parent, string label)",
  "function getResolver(string label) view returns (address)",
  "function getSubregistry(string label) view returns (address)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getTokenId(uint256 anyId) view returns (uint256)",
  "function initialize((address account, uint256 roleBitmap)[] grants)",
]);
export const resolverAbi = parseAbi([
  "function setContenthash(bytes name, bytes hash)",
  "function setText(bytes name, string key, string value)",
  "function multicall(bytes[] calls) returns (bytes[])",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);
export const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);
export const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
]);
export const helperAbi = parseAbi(["function findExactOwner(bytes name) view returns (address)"]);
export const deployRegistryAbi = parseAbi([
  "function logDeploy(bytes32 node, bytes cid, string env, string meta)",
  "function setPublisher(bytes dnsName, address publisher, bool allowed)",
]);

export const dnsEncode = (name: string): Hex => toHex(packetToBytes(normalize(name)));
export const labelId = (label: string) => BigInt(keccak256(toHex(label)));

export const encodeContenthash = (cid: string): Hex =>
  concat(["0xe301", toHex(CID.parse(cid).toV1().bytes)]);

export function decodeContenthash(hex: Hex): string {
  if (!hex.toLowerCase().startsWith("0xe301")) throw new Error("not an ipfs contenthash");
  return CID.decode(hexToBytes(`0x${hex.slice(6)}`)).toString();
}

export const sameCid = (a: string, b: string) => CID.parse(a).toV1().equals(CID.parse(b).toV1());

/** Writes the site pointer and manifest pointer together. */
export const publishCalls = (name: string, contenthash: Hex, manifestCid: string): Hex[] => {
  const dns = dnsEncode(name);
  return [
    encodeFunctionData({ abi: resolverAbi, functionName: "setContenthash", args: [dns, contenthash] }),
    encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dns, "ensure.manifest", manifestCid] }),
  ];
};

type Reader = { readContract: (args: any) => Promise<any> };

async function resolveCall(client: Reader, name: string, data: Hex, functionName: "contenthash" | "text") {
  const [result, resolver] = await client.readContract({
    address: SEPOLIA.universalResolver,
    abi: universalResolverAbi,
    functionName: "resolve",
    args: [dnsEncode(name), data],
  });
  return { value: decodeFunctionResult({ abi: resolverAbi, functionName, data: result }) as Hex | string, resolver: resolver as Address };
}

export async function readContenthash(client: Reader, name: string) {
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "contenthash", args: [namehash(normalize(name))] });
  const { value, resolver } = await resolveCall(client, name, data, "contenthash");
  return { contenthash: value as Hex, resolver };
}

export async function readText(client: Reader, name: string, key: string) {
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(normalize(name)), key] });
  return (await resolveCall(client, name, data, "text")).value as string;
}

export async function findResolver(client: Reader, name: string): Promise<Address> {
  const [resolver] = await client.readContract({
    address: SEPOLIA.universalResolver,
    abi: universalResolverAbi,
    functionName: "findResolver",
    args: [dnsEncode(name)],
  });
  return resolver;
}

export const findOwner = (client: Reader, name: string): Promise<Address> =>
  client.readContract({ address: SEPOLIA.universalHelper, abi: helperAbi, functionName: "findExactOwner", args: [dnsEncode(name)] });
