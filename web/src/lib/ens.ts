import {
  decodeContenthash,
  dnsEncode,
  findOwner,
  findResolver,
  labelId,
  readContenthash,
  readText,
  sameCid,
} from "@ensure/core/ens";
import type { Address, Hex } from "viem";
import { deployment, publicClient } from "./config";

export { decodeContenthash, dnsEncode, labelId, sameCid };
export type TextRecords = Record<string, string>;

export const ENS_TEXT_KEYS = [
  "ensure.manifest",
  "ensure.release",
  "ensure.approval",
  "ensure.build",
  "ensure.policy",
] as const;

export type NameSnapshot = {
  name: string;
  resolver: Address;
  contenthash: Hex;
  cid: string;
  owner: Address;
  records: TextRecords;
  fetchedAt: number;
};

export async function readNameSnapshot(name: string): Promise<NameSnapshot> {
  const normalized = name.trim().toLowerCase();
  const [resolver, content, owner, entries] = await Promise.all([
    findResolver(publicClient, normalized),
    readContenthash(publicClient, normalized),
    findOwner(publicClient, normalized),
    Promise.all(ENS_TEXT_KEYS.map(async (key) => [key, await readText(publicClient, normalized, key)] as const)),
  ]);
  const cid = decodeContenthash(content.contenthash);
  return {
    name: normalized,
    resolver,
    contenthash: content.contenthash,
    cid,
    owner,
    records: Object.fromEntries(entries),
    fetchedAt: Date.now(),
  };
}

export const expectedOwner = deployment.owner as Address;
