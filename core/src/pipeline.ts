// Validate, hash, pin, and publish. Node only. Used by the server and CLI.
import { readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Address, type Hex } from "viem";
import { buildManifest, commitDigest, hashFiles, manifestBytes, manifestDigest, mimeFor, type Manifest } from "./manifest";
import { encodeContenthash, publishCalls, readContenthash, readText, resolverAbi, sameCid, decodeContenthash } from "./ens";

export type Log = (line: string) => void;
export type SiteFile = { path: string; bytes: Uint8Array };

const BAD_NAME = [/(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/, /(^|\/)\.git(\/|$)/, /(^|\/)\.npmrc$/, /(^|\/)id_rsa/];
const BAD_CONTENT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bghp_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk-or-v1-[a-f0-9]{30,}/];

/** Reads an output folder, refusing anything that shouldn't be published. */
export async function readOutput(dir: string): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  async function walk(rel: string) {
    for (const e of await readdir(join(dir, rel))) {
      const path = rel ? `${rel}/${e}` : e;
      const st = await lstat(join(dir, path));
      if (st.isSymbolicLink()) throw new Error(`symlink in output: ${path}`);
      if (st.isDirectory()) { await walk(path); continue; }
      if (!st.isFile()) throw new Error(`unsupported file in output: ${path}`);
      if (BAD_NAME.some((r) => r.test(path))) throw new Error(`refusing to publish: ${path}`);
      const bytes = new Uint8Array(await readFile(join(dir, path)));
      if (bytes.length < 5_000_000) {
        const text = Buffer.from(bytes).toString("latin1");
        if (BAD_CONTENT.some((r) => r.test(text))) throw new Error(`secret-like content in: ${path}`);
      }
      files.push({ path, bytes });
    }
  }
  await walk("");
  if (!files.length) throw new Error("build output is empty");
  if (!files.some((f) => f.path === "index.html")) throw new Error("build output has no index.html");
  return files;
}

export type PinConfig = { jwt: string; apiUrl?: string; uploadsUrl?: string; gateways?: string[]; retryMs?: number };
export const gatewaysFrom = (c: PinConfig) => c.gateways ?? ["https://ipfs.io", "https://dweb.link"];

async function pinataJson(res: Response, what: string) {
  if (!res.ok) throw new Error(`Pinata ${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<any>;
}

/** Folders must use pinFileToIPFS: Pinata's v3 endpoint doesn't take them. */
export async function pinSite(c: PinConfig, files: SiteFile[], name: string): Promise<string> {
  const form = new FormData();
  for (const f of files) form.append("file", new Blob([Buffer.from(f.bytes)], { type: mimeFor(f.path) }), `release/${f.path}`);
  form.append("pinataMetadata", JSON.stringify({ name }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const res = await fetch(`${c.apiUrl ?? "https://api.pinata.cloud"}/pinning/pinFileToIPFS`, {
    method: "POST", headers: { Authorization: `Bearer ${c.jwt}` }, body: form,
  });
  const cid = (await pinataJson(res, "site upload")).IpfsHash;
  if (!cid) throw new Error("Pinata returned no CID");
  return cid;
}

/** Uploaded as a file, with network=public, so the bytes stay exact and readable. */
export async function pinManifest(c: PinConfig, bytes: Uint8Array, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type: "application/json" }), "manifest.json");
  form.append("network", "public");
  form.append("name", name);
  const res = await fetch(`${c.uploadsUrl ?? "https://uploads.pinata.cloud"}/v3/files`, {
    method: "POST", headers: { Authorization: `Bearer ${c.jwt}` }, body: form,
  });
  const cid = (await pinataJson(res, "manifest upload")).data?.cid;
  if (!cid) throw new Error("Pinata returned no CID");
  return cid;
}

/** Fetches by CID through public gateways until the exact bytes come back. Also warms them. */
export async function fetchBack(c: PinConfig, path: string, expected: Uint8Array, log: Log, attempts = 8): Promise<void> {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    for (const gateway of gatewaysFrom(c)) {
      try {
        const res = await fetch(`${gateway}/ipfs/${path}`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) { lastError = `${gateway}: HTTP ${res.status}`; continue; }
        const got = new Uint8Array(await res.arrayBuffer());
        if (Buffer.compare(got, expected) === 0) return;
        lastError = `${gateway}: bytes differ`;
      } catch (e) { lastError = `${gateway}: ${(e as Error).message}`; }
    }
    if (i < attempts - 1) {
      log(`  waiting for gateways (${lastError})`);
      await new Promise((r) => setTimeout(r, Math.min((c.retryMs ?? 2000) * 2 ** i, 15000)));
    }
  }
  throw new Error(`could not fetch ${path} back: ${lastError}`);
}

export type PinInput = {
  dir: string; commitSha: string; repositoryId: string; repositoryUrl: string; runUrl: string;
  buildTools: Record<string, string>; label: string;
};
export type Pinned = { manifest: Manifest; siteCid: string; manifestCid: string; manifestDigest: Hex; commitDigest: Hex; contenthash: Hex };

export async function pinRelease(c: PinConfig, i: PinInput, log: Log): Promise<Pinned> {
  const files = await readOutput(i.dir);
  log(`Validated ${files.length} files`);
  const siteCid = await pinSite(c, files, `${i.label}-site`);
  log(`Site CID: ${siteCid}`);
  const manifest = buildManifest({
    repositoryId: i.repositoryId, repositoryUrl: i.repositoryUrl, commitSha: i.commitSha,
    workflowRunUrl: i.runUrl, siteCid, buildTools: i.buildTools, files: hashFiles(files),
  });
  const bytes = manifestBytes(manifest);
  const manifestCid = await pinManifest(c, bytes, `${i.label}-manifest`);
  log(`Manifest CID: ${manifestCid}`);
  await fetchBack(c, manifestCid, bytes, log);
  // Prefer a non-HTML probe: some free Pinata gateways block text/html (403) while CSS/JS/SVG still match.
  const probe = files.find((f) => !/\.(?:html?)$/i.test(f.path)) ?? files.find((f) => f.path === "index.html")!;
  await fetchBack(c, `${siteCid}/${probe.path}`, probe.bytes, log);
  log(`Fetched manifest and site probe (${probe.path}) back by CID`);
  return { manifest, siteCid, manifestCid, manifestDigest: manifestDigest(bytes), commitDigest: commitDigest(i.commitSha), contenthash: encodeContenthash(siteCid) };
}

type Chain = { public: any; wallet: any; account: Address };

/** Writes both records in one transaction, then reads them back through the Universal Resolver. */
export async function publishName(chain: Chain, resolver: Address, name: string, p: Pick<Pinned, "contenthash" | "manifestCid">, log: Log): Promise<Hex> {
  const hash = await chain.wallet.writeContract({
    address: resolver, abi: resolverAbi, functionName: "multicall", args: [publishCalls(name, p.contenthash, p.manifestCid)],
  });
  log(`Transaction: ${hash}`);
  const receipt = await chain.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  const onChain = await readContenthash(chain.public, name);
  const manifest = await readText(chain.public, name, "ensure.manifest");
  if (onChain.contenthash.toLowerCase() !== p.contenthash.toLowerCase()) throw new Error(`read-back mismatch: ${name} serves ${onChain.contenthash}`);
  if (manifest !== p.manifestCid) throw new Error(`read-back mismatch: ${name} manifest is ${manifest}`);
  if (!sameCid(decodeContenthash(onChain.contenthash), decodeContenthash(p.contenthash))) throw new Error("read-back CID mismatch");
  log(`${name} now serves ${decodeContenthash(onChain.contenthash)}`);
  return hash;
}

/** True if the publisher can't write production. It must revert. */
export async function prodWriteBlocked(chain: Chain, prodResolver: Address, prodName: string, contenthash: Hex): Promise<boolean> {
  try {
    await chain.public.simulateContract({
      address: prodResolver, abi: resolverAbi, functionName: "multicall",
      args: [publishCalls(prodName, contenthash, "blocked-check")], account: chain.account,
    });
    return false;
  } catch (e: any) {
    // Only a real revert counts. An RPC failure must not read as "blocked".
    if (e?.name === "ContractFunctionExecutionError" && e.cause?.name === "ContractFunctionRevertedError") return true;
    throw e;
  }
}
