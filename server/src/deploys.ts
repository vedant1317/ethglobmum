// The deploy itself: a Postgres-backed queue, one job per deploy.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createPublicClient, createWalletClient, http, namehash, toBytes, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { z } from "zod";
import { deployRegistryAbi, registryAbi, dnsEncode } from "@ensure/core/ens";
import { pinRelease, prodWriteBlocked, publishName, type PinConfig } from "@ensure/core/pipeline";
import type { Deploy, Receipt } from "@ensure/core/api";
import { requireUser, type Env } from "./auth";
import { build, latestSha } from "./builder";
import { sql } from "./db";
import { installationToken } from "./github";
import { ipnsPublish } from "./ipns";
import { candidateEventId, recordReleaseEvent } from "@ensure/arkiv";

export const chain = () => {
  const transport = http(process.env.SEPOLIA_RPC_URL);
  const account = privateKeyToAccount(process.env.PUBLISHER_PRIVATE_KEY as `0x${string}`);
  return { public: createPublicClient({ chain: sepolia, transport }), wallet: createWalletClient({ chain: sepolia, transport, account }), account: account.address as Address };
};
export const pinConfig = (): PinConfig => ({
  jwt: process.env.PINATA_JWT ?? "",
  apiUrl: process.env.PINATA_API_URL,
  uploadsUrl: process.env.PINATA_UPLOADS_URL,
  gateways: process.env.IPFS_GATEWAYS?.split(","),
  retryMs: process.env.IPFS_RETRY_MS ? Number(process.env.IPFS_RETRY_MS) : undefined,
});
const platform = () => ({ registry: process.env.PLATFORM_REGISTRY as Address, resolver: process.env.PLATFORM_RESOLVER as Address });
const openUrl = (cid: string) => `https://${cid}.ipfs.dweb.link`;

const toDeploy = (r: any): Deploy => ({
  id: r.id, projectId: r.project_id, commitSha: r.commit_sha, status: r.status, dryRun: r.dry_run, error: r.error, receipt: r.receipt, createdAt: r.created_at,
});

export async function createDeploy(projectId: string, o: { commitSha?: string; dryRun?: boolean } = {}) {
  const [d] = await sql`INSERT INTO deploys (project_id, commit_sha, dry_run) VALUES (${projectId}, ${o.commitSha ?? null}, ${o.dryRun ?? false}) RETURNING *`;
  return toDeploy(d);
}

const addLog = (id: string, line: string, kind = "log") => sql`INSERT INTO deploy_logs (deploy_id, kind, line) VALUES (${id}, ${kind}, ${line})`;

// One publisher key means one sender at a time.
let chainLock: Promise<unknown> = Promise.resolve();
export function withChainLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chainLock.then(fn, fn);
  chainLock = next.catch(() => {});
  return next;
}

async function ensureQuickName(c: ReturnType<typeof chain>, name: string, log: (l: string) => void) {
  const label = name.split(".")[0];
  const p = platform();
  const resolver = await c.public.readContract({ address: p.registry, abi: registryAbi, functionName: "getResolver", args: [label] });
  if (resolver !== "0x0000000000000000000000000000000000000000") return;
  log(`Registering ${name}`);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const hash = await c.wallet.writeContract({
    address: p.registry, abi: registryAbi, functionName: "register",
    args: [label, c.account, "0x0000000000000000000000000000000000000000", p.resolver, 0n, expiry],
  });
  const r = await c.public.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Name registration reverted: ${hash}`);
  const registry = process.env.DEPLOY_REGISTRY as Address | undefined;
  if (registry) {
    const h = await c.wallet.writeContract({ address: registry, abi: deployRegistryAbi, functionName: "setPublisher", args: [dnsEncode(name), c.account, true] });
    await c.public.waitForTransactionReceipt({ hash: h });
  }
}

async function logOnChain(c: ReturnType<typeof chain>, name: string, cid: string, env: string, meta: string, log: (l: string) => void) {
  const address = process.env.DEPLOY_REGISTRY as Address | undefined;
  if (!address) return undefined;
  // The log is a record, not the source of truth, so a failure doesn't undo the deploy.
  try {
    const hash = await c.wallet.writeContract({ address, abi: deployRegistryAbi, functionName: "logDeploy", args: [namehash(name), `0x${Buffer.from(toBytes(cid)).toString("hex")}`, env, meta] });
    const r = await c.public.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("reverted");
    log(`Logged on-chain: ${hash}`);
    return hash as string;
  } catch (e) {
    log(`Deploy log skipped: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function runDeploy(d: any) {
  // Queries run only when awaited, so log lines go through an ordered queue.
  let writes: Promise<unknown> = Promise.resolve();
  const enqueue = (line: string, kind?: string) => { writes = writes.then(() => addLog(d.id, line, kind)).catch((e) => console.error("[log]", e)); };
  const log = (l: string) => enqueue(l);
  const stage = (s: string) => enqueue(s, "stage");
  try {
    return await runStages(d, log, stage);
  } finally {
    await writes;
  }
}

async function runStages(d: any, log: (l: string) => void, stage: (s: string) => void) {
  const [p] = await sql`SELECT * FROM projects WHERE id = ${d.project_id}`;
  const token = p.repo_private ? await installationToken(p.owner, p.repo) : undefined;
  const sha: string = d.commit_sha ?? (await latestSha(p.owner, p.repo, p.branch, token));
  if (!d.commit_sha) await sql`UPDATE deploys SET commit_sha = ${sha} WHERE id = ${d.id}`;

  stage("build");
  const built = await build({ owner: p.owner, repo: p.repo, sha, subfolder: p.subfolder, outputDir: p.output_dir, token }, log);
  try {
    stage("pin");
    const repoUrl = `https://github.com/${p.owner}/${p.repo}`;
    if (d.dry_run) {
      const { readOutput } = await import("@ensure/core/pipeline");
      log(`Dry run: ${(await readOutput(built.dir)).length} files would be published`);
      return { status: "built", receipt: null };
    }
    const pinned = await pinRelease(pinConfig(), {
      dir: built.dir, commitSha: sha, repositoryId: p.repo_id, repositoryUrl: repoUrl,
      runUrl: `${process.env.API_URL ?? ""}/deploys/${d.id}`, buildTools: built.buildTools, label: `${p.name}-${sha.slice(0, 8)}`,
    }, log);

    stage("publish");
    if ((await latestSha(p.owner, p.repo, p.branch, token)) !== sha) {
      log(`${p.branch} has moved past ${sha}. Not publishing`);
      return { status: "superseded", receipt: null };
    }
    const c = chain();
    const target = p.mode === "quick" ? p.name : p.preview_name;
    const result = await withChainLock(async () => {
      if (p.mode === "quick") await ensureQuickName(c, p.name, log);
      const txHash = await publishName(c, p.resolver, target, pinned, log);
      let blocked: boolean | undefined;
      if (p.mode === "custom" && p.prod_resolver) {
        blocked = await prodWriteBlocked(c, p.prod_resolver, `prod.${p.name}`, pinned.contenthash);
        if (!blocked) throw new Error("Publisher can write production. Revoke its production role");
        log("Confirmed: this key can't write production");
      }
      const logTxHash = await logOnChain(c, target, pinned.siteCid, p.mode === "quick" ? "production" : "preview", `commit:${sha}`, log);
      return { txHash, blocked, logTxHash };
    });
    const ipns = await ipnsPublish(p as any, pinned.siteCid, log);
    const receipt: Receipt = {
      commitSha: sha, repositoryId: p.repo_id, siteCid: pinned.siteCid, manifestCid: pinned.manifestCid, manifestDigest: pinned.manifestDigest,
      commitDigest: pinned.commitDigest, contenthash: pinned.contenthash, name: target, txHash: result.txHash, logTxHash: result.logTxHash,
      ipns, prodWriteBlocked: result.blocked, url: openUrl(pinned.siteCid),
    };
    if (p.mode === "custom") {
      try {
        const recorded = await recordReleaseEvent({
          projectNode: namehash(p.name),
          eventId: candidateEventId(p.id, d.id, sha),
          eventType: "CANDIDATE",
          commitSha: sha,
          manifestCid: pinned.manifestCid,
          manifestDigest: pinned.manifestDigest,
          siteCid: pinned.siteCid,
          commitDigest: pinned.commitDigest,
          sourceTx: result.txHash,
          sourceChain: 11155111,
        });
        log(`Arkiv candidate: ${recorded.entityKey}${"txHash" in recorded ? ` (${recorded.txHash})` : " (already recorded)"}`);
      } catch (error) {
        log(`Arkiv candidate sync skipped: ${(error as Error).message.split("\n")[0]}`);
      }
    }
    return { status: p.mode === "quick" ? "live" : "preview", receipt };
  } finally {
    await built.cleanup();
  }
}

/** Claims queued deploys, up to a limit. Running deploys found at startup died with the old process. */
export async function startWorker(max = Number(process.env.MAX_CONCURRENT_DEPLOYS ?? 3), intervalMs = 1000) {
  await sql`UPDATE deploys SET status = 'failed', error = 'Server restarted during this deploy' WHERE status = 'running'`;
  let active = 0;
  const tick = async () => {
    while (active < max) {
      const [d] = await sql`UPDATE deploys SET status = 'running' WHERE id = (
        SELECT id FROM deploys WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
      if (!d) return;
      active++;
      runDeploy(d)
        .then(async ({ status, receipt }) => { await sql`UPDATE deploys SET status = ${status}, receipt = ${receipt ? sql.json(receipt as any) : null} WHERE id = ${d.id}`; })
        .catch(async (e: Error) => {
          console.error(`[deploy ${d.id}]`, e);
          await sql`UPDATE deploys SET status = 'failed', error = ${e.message.split("\n")[0]} WHERE id = ${d.id}`;
        })
        .finally(() => { active--; });
    }
  };
  const timer = setInterval(() => void tick().catch((e) => console.error("[worker]", e)), intervalMs);
  return () => clearInterval(timer);
}

const FINISHED = new Set(["live", "preview", "built", "superseded", "failed"]);

export const deploys = new Hono<Env>();

const mine = async (id: string, userId: string) => {
  if (!z.string().uuid().safeParse(id).success) return undefined;
  const [d] = await sql`SELECT d.* FROM deploys d JOIN projects p ON p.id = d.project_id WHERE d.id = ${id} AND p.user_id = ${userId}`;
  return d;
};

deploys.post("/", requireUser, async (c) => {
  const body = z.object({ projectId: z.string().uuid(), commitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(), dryRun: z.boolean().optional() }).parse(await c.req.json());
  const [p] = await sql`SELECT id FROM projects WHERE id = ${body.projectId} AND user_id = ${c.get("user").id}`;
  if (!p) return c.json({ error: "Project not found" }, 404);
  return c.json({ deploy: await createDeploy(p.id, body) }, 202);
});

deploys.get("/:id", requireUser, async (c) => {
  const d = await mine(c.req.param("id") as string, c.get("user").id);
  return d ? c.json({ deploy: toDeploy(d) }) : c.json({ error: "Deploy not found" }, 404);
});

deploys.get("/:id/events", requireUser, async (c) => {
  const id = c.req.param("id") as string;
  if (!(await mine(id, c.get("user").id))) return c.json({ error: "Deploy not found" }, 404);
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (s) => {
    let seq = 0, lastBeat = Date.now();
    while (!s.aborted) {
      const rows = await sql`SELECT seq, kind, line FROM deploy_logs WHERE deploy_id = ${id} AND seq > ${seq} ORDER BY seq`;
      for (const r of rows) {
        seq = Number(r.seq);
        await s.writeSSE(r.kind === "stage" ? { event: "stage", data: JSON.stringify({ stage: r.line }) } : { event: "log", data: JSON.stringify({ line: r.line }) });
      }
      const [d] = await sql`SELECT * FROM deploys WHERE id = ${id}`;
      if (FINISHED.has(d.status) && !rows.length) {
        await s.writeSSE(d.status === "failed" ? { event: "error", data: JSON.stringify({ message: d.error }) } : { event: "done", data: JSON.stringify(toDeploy(d)) });
        return;
      }
      if (Date.now() - lastBeat > 15_000) { await s.writeSSE({ event: "heartbeat", data: "{}" }); lastBeat = Date.now(); }
      await s.sleep(500);
    }
  });
});
