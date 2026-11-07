#!/usr/bin/env tsx
// Terminal client. Everything but `publish` and `env get` goes through the API.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { decodeContenthash, dnsEncode, findResolver, readContenthash, readText, resolverAbi } from "@ensure/core/ens";
import { pinRelease, publishName } from "@ensure/core/pipeline";
import type { Deploy, Project } from "@ensure/core/api";
import { createVerifier, statusWord, type VerificationCheck, type VerifierClient, type VerifyStatus } from "@ensure/core/verify";
import { DEFAULT_GATEWAYS, normalizeGateways } from "@ensure/core/ipfs";
import deployment from "../../deployments/sepolia.json" with { type: "json" };

const CONFIG = "ensure.json";
const TOKEN_FILE = join(homedir(), ".ensure", "token");
const apiUrl = () => process.env.ENSURE_API ?? "http://localhost:3001";
const token = () => process.env.ENSURE_TOKEN ?? (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "");
const config = (): { projectId?: string; name?: string } => (existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {});
const rpc = () => process.env.SEPOLIA_RPC_URL;
const reader = () => createPublicClient({ chain: sepolia, transport: http(rpc()) });

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...init.headers },
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const projectId = (given?: string) => {
  const id = given ?? config().projectId;
  if (!id) throw new Error(`No project. Run "ensure init" or pass --project`);
  return id;
};

/** Reads the one SSE format from core/src/api.ts. */
async function follow(id: string): Promise<Deploy> {
  const res = await fetch(`${apiUrl()}/deploys/${id}/events`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok || !res.body) throw new Error(`Couldn't follow deploy: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const b of blocks) {
      const event = b.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(b.match(/^data: (.*)$/m)?.[1] ?? "{}");
      if (event === "log") console.log(`  ${data.line}`);
      if (event === "stage") console.log(`\n${data.stage}`);
      if (event === "error") throw new Error(data.message);
      if (event === "done") return data as Deploy;
    }
  }
  throw new Error("Stream ended early");
}

const program = new Command().name("ensure").description("Deploy websites to ENS");

program.command("init").description("Connect this repo and write ensure.json")
  .requiredOption("--repo <url>", "GitHub URL")
  .option("--branch <branch>").option("--subfolder <path>").option("--output <dir>", "build output folder")
  .option("--name <name.eth>", "your own name. Omit for a quick name")
  .action(async (o) => {
    const { project } = await api<{ project: Project }>("/projects", {
      method: "POST", body: JSON.stringify({ repoUrl: o.repo, branch: o.branch, subfolder: o.subfolder, outputDir: o.output, name: o.name }),
    });
    writeFileSync(CONFIG, JSON.stringify({ projectId: project.id, name: project.name }, null, 2) + "\n");
    console.log(`Connected ${project.repoUrl} to ${project.name}. Wrote ${CONFIG}`);
  });

program.command("login").description("Log in through GitHub").option("--provider <p>", "github or google", "github").action(async (o) => {
  const got = await new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      const t = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
      res.end(t ? "Logged in. You can close this tab." : "Login failed.");
      server.close();
      resolve(t ?? "");
    }).listen(0, "127.0.0.1", () => {
      console.log(`Open this to log in:\n${apiUrl()}/auth/${o.provider}?cli=${(server.address() as any).port}`);
    });
  });
  if (!got) throw new Error("Login failed");
  mkdirSync(join(homedir(), ".ensure"), { recursive: true });
  writeFileSync(TOKEN_FILE, got);
  chmodSync(TOKEN_FILE, 0o600);
  console.log("Logged in");
});

program.command("push").description("Deploy, stream the logs, print the receipt")
  .option("--project <id>").option("--dry-run", "build and validate only")
  .action(async (o) => {
    const { deploy } = await api<{ deploy: Deploy }>("/deploys", { method: "POST", body: JSON.stringify({ projectId: projectId(o.project), dryRun: !!o.dryRun }) });
    const done = await follow(deploy.id);
    console.log(`\n${done.status}`);
    if (done.receipt) console.log(JSON.stringify(done.receipt, null, 2));
  });

program.command("publish <dir>").description("Pin and publish a built folder with your own keys, no server")
  .requiredOption("--name <name>", "the name to write").requiredOption("--repo <url>").requiredOption("--commit <sha>")
  .option("--run-url <url>", "link to this build", "local").option("--repository-id <id>", "GitHub repo ID", "0")
  .action(async (dir, o) => {
    const key = process.env.PUBLISHER_PRIVATE_KEY as Hex, jwt = process.env.PINATA_JWT;
    if (!key || !jwt || !rpc()) throw new Error("Set PUBLISHER_PRIVATE_KEY, PINATA_JWT and SEPOLIA_RPC_URL");
    const log = (l: string) => console.log(`  ${l}`);
    const pinned = await pinRelease(
      { jwt, apiUrl: process.env.PINATA_API_URL, uploadsUrl: process.env.PINATA_UPLOADS_URL, gateways: process.env.IPFS_GATEWAYS?.split(","), retryMs: process.env.IPFS_RETRY_MS ? Number(process.env.IPFS_RETRY_MS) : undefined },
      { dir, commitSha: o.commit, repositoryId: o.repositoryId, repositoryUrl: o.repo, runUrl: o.runUrl, buildTools: { node: process.version }, label: `${o.name}-${o.commit.slice(0, 8)}` },
      log,
    );
    const account = privateKeyToAccount(key);
    const client = reader();
    const resolver = await findResolver(client, o.name);
    const tx = await publishName({ public: client, wallet: createWalletClient({ chain: sepolia, transport: http(rpc()), account }), account: account.address }, resolver, o.name, pinned, log);
    writeFileSync("receipt.json", JSON.stringify({ commitSha: o.commit, siteCid: pinned.siteCid, manifestCid: pinned.manifestCid, manifestDigest: pinned.manifestDigest, commitDigest: pinned.commitDigest, contenthash: pinned.contenthash, name: o.name, txHash: tx }, null, 2) + "\n");
    console.log("Wrote receipt.json");
  });

program.command("status [name]").description("What a name serves, and recent deploys").action(async (given) => {
  const name = given ?? config().name;
  if (!name) throw new Error("Pass a name, or run inside a project");
  const { contenthash, resolver } = await readContenthash(reader(), name);
  const cid = decodeContenthash(contenthash);
  console.log(`Name:     ${name}\nCID:      ${cid}\nManifest: ${await readText(reader(), name, "ensure.manifest")}\nResolver: ${resolver}\nOpen:     https://${cid}.ipfs.dweb.link`);
  if (config().projectId && token()) {
    const { deploys } = await api(`/projects/${config().projectId}/deploys`);
    console.log("\nRecent deploys:");
    for (const d of deploys.slice(0, 5)) console.log(`  ${d.id}  ${d.status.padEnd(10)} ${d.commitSha?.slice(0, 8) ?? ""}  ${d.receipt?.siteCid ?? d.error ?? ""}`);
  }
});

program.command("rollback <deployId>").description("Point a quick name back at an earlier deploy").option("--project <id>").action(async (deployId, o) => {
  const r = await api(`/projects/${projectId(o.project)}/rollback`, { method: "POST", body: JSON.stringify({ deployId }) });
  console.log(`${r.name} now serves ${r.siteCid}\nTransaction: ${r.txHash}`);
});

/** Exit codes let scripts and CI act on the result. UNPROTECTED and UNAVAILABLE are never success. */
const VERIFY_EXIT: Record<VerifyStatus, number> = { MATCH: 0, MISMATCH: 1, UNAVAILABLE: 2, UNPROTECTED: 3 };
const CHECK_MARK: Record<VerificationCheck["state"], string> = { pass: "✓", fail: "✗", unavailable: "?", info: "·" };

program.command("verify [name]")
  .description("Check that a name serves the release its owner approved. Reads Sepolia and public IPFS only, never the ENSure server")
  .option("--unprotected", "check as an unprotected (quick) name: files against the build manifest, no approval")
  .option("--json", "print the full result as JSON")
  .action(async (given, o) => {
    const name = given ?? config().name ?? deployment.projectName;
    const client = createPublicClient({ chain: sepolia, transport: http(rpc() || "https://ethereum-sepolia-rpc.publicnode.com", { timeout: 15_000 }) });
    const gateways = normalizeGateways([...(process.env.IPFS_GATEWAYS ?? "").split(","), ...DEFAULT_GATEWAYS]);
    const verifier = createVerifier({ client: client as unknown as VerifierClient, deployment, gateways });
    const result = o.unprotected ? await verifier.verifyUnprotectedName(name) : await verifier.verifyProject(name);
    if (o.json) {
      console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    } else {
      console.log(`Verifying ${result.name}${result.blockNumber !== undefined ? ` at Sepolia block ${result.blockNumber}` : ""}\n`);
      for (const c of result.checks) console.log(`  ${CHECK_MARK[c.state]} ${c.label}\n      ${c.detail}`);
      console.log(`\n${statusWord(result.status)}  ${result.status}${result.release ? `  release ${result.release}` : ""}${result.commit ? `  commit ${result.commit.slice(0, 12)}` : ""}`);
      if (result.explanation) console.log(result.explanation);
      console.log("\nThis checks the release matches what the owner approved. It doesn't mean the code is safe.");
    }
    process.exitCode = VERIFY_EXIT[result.status];
  });

const env = program.command("env").description("ENS text records");
env.command("get <key>").option("--name <name>").action(async (key, o) => {
  console.log(await readText(reader(), o.name ?? config().name!, key));
});
env.command("set <key> <value>").description("Quick names use the server. Otherwise signs with ENSURE_SIGNER_KEY")
  .option("--name <name>", "a name you own").option("--project <id>")
  .action(async (key, value, o) => {
    const signer = process.env.ENSURE_SIGNER_KEY as Hex | undefined;
    if (o.name && signer) {
      const account = privateKeyToAccount(signer);
      const client = reader();
      const wallet = createWalletClient({ chain: sepolia, transport: http(rpc()), account });
      const hash = await wallet.writeContract({ address: (await findResolver(client, o.name)) as Address, abi: resolverAbi, functionName: "setText", args: [dnsEncode(o.name), key, value] });
      await client.waitForTransactionReceipt({ hash });
      return console.log(`Set ${key}. Transaction: ${hash}`);
    }
    const r = await api(`/projects/${projectId(o.project)}/records`, { method: "POST", body: JSON.stringify({ key, value }) });
    console.log(`Set ${key}. Transaction: ${r.txHash}`);
  });

await program.parseAsync().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
