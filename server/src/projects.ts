// Connected repos and their names.
import { Hono } from "hono";
import { isAddress, namehash, type Address, type Hex } from "viem";
import { z } from "zod";
import { RESOLVER_ROLES, findResolver, readText, resolverAbi, dnsEncode } from "@ensure/core/ens";
import { recordControllerEventFromTransaction } from "@ensure/arkiv";
import { publishName } from "@ensure/core/pipeline";
import type { Project } from "@ensure/core/api";
import { requireUser, type Env } from "./auth";
import { checkRelative, parseRepoUrl } from "./builder";
import { sql } from "./db";
import { chain, createDeploy, withChainLock } from "./deploys";
import { repoAccess } from "./github";
import { NAME, generateQuickName, isVerified } from "./names";

const toProject = (r: any): Project => ({
  id: r.id, repoUrl: `https://github.com/${r.owner}/${r.repo}`, branch: r.branch, subfolder: r.subfolder, outputDir: r.output_dir,
  mode: r.mode, name: r.name, previewName: r.preview_name,
});

export async function createProject(u: { id: string; githubToken: string | null }, input: { repoUrl: string; branch?: string; subfolder?: string; outputDir?: string; name?: string }) {
  const ref = parseRepoUrl(input.repoUrl);
  const info = await repoAccess(ref.owner, ref.repo, u.githubToken);
  const subfolder = input.subfolder ?? ref.subfolder;
  checkRelative(subfolder);
  if (input.outputDir) checkRelative(input.outputDir);
  const branch = input.branch ?? ref.branch ?? info.defaultBranch;

  let row: Record<string, unknown>;
  if (input.name) {
    if (!NAME.test(input.name)) throw Object.assign(new Error("Custom names must look like project.eth"), { status: 400 });
    if (!(await isVerified(input.name, u.id))) throw Object.assign(new Error(`Prove you own ${input.name} first`), { status: 403 });
    const c = chain();
    const previewName = `preview.${input.name}`;
    const resolver = await findResolver(c.public, previewName).catch(() => null);
    const prodResolver = await findResolver(c.public, `prod.${input.name}`).catch(() => null);
    const canWrite = resolver && await c.public.readContract({ address: resolver, abi: resolverAbi, functionName: "hasRootRoles", args: [RESOLVER_ROLES.SET_CONTENTHASH, c.account] }).catch(() => false);
    if (!canWrite) throw Object.assign(new Error(`${previewName} isn't set up for this server. Run: pnpm setup-ens project ${input.name}`), { status: 409 });
    row = { mode: "custom", name: input.name, preview_name: previewName, resolver, prod_resolver: prodResolver };
  } else {
    row = { mode: "quick", name: await generateQuickName(), preview_name: null, resolver: process.env.PLATFORM_RESOLVER, prod_resolver: null };
  }
  const [p] = await sql`INSERT INTO projects ${sql({
    user_id: u.id, owner: ref.owner, repo: ref.repo, repo_id: info.id, repo_private: info.private, branch, subfolder, output_dir: input.outputDir ?? null, ...row,
  } as any)} RETURNING *`;
  return toProject(p);
}

export const projects = new Hono<Env>();
projects.use(requireUser);

const owned = async (id: string, userId: string) => {
  if (!z.string().uuid().safeParse(id).success) return undefined;
  const [p] = await sql`SELECT * FROM projects WHERE id = ${id} AND user_id = ${userId}`;
  return p;
};

projects.get("/", async (c) => {
  const rows = await sql`SELECT * FROM projects WHERE user_id = ${c.get("user").id} ORDER BY created_at DESC`;
  return c.json({ projects: rows.map(toProject) });
});

projects.post("/", async (c) => {
  const body = z.object({ repoUrl: z.string().url(), branch: z.string().optional(), subfolder: z.string().optional(), outputDir: z.string().optional(), name: z.string().optional(), deploy: z.boolean().optional() }).parse(await c.req.json());
  const project = await createProject({ id: c.get("user").id, githubToken: c.get("githubToken") }, body);
  const deploy = body.deploy ? await createDeploy(project.id) : undefined;
  return c.json({ project, deploy }, 201);
});

projects.get("/:id", async (c) => {
  const p = await owned(c.req.param("id") as string, c.get("user").id);
  return p ? c.json({ project: toProject(p) }) : c.json({ error: "Project not found" }, 404);
});

projects.delete("/:id", async (c) => {
  const p = await owned(c.req.param("id") as string, c.get("user").id);
  if (!p) return c.json({ error: "Project not found" }, 404);
  await sql`DELETE FROM projects WHERE id = ${p.id}`;
  return c.json({ ok: true });
});

projects.get("/:id/deploys", async (c) => {
  const p = await owned(c.req.param("id") as string, c.get("user").id);
  if (!p) return c.json({ error: "Project not found" }, 404);
  const rows = await sql`SELECT * FROM deploys WHERE project_id = ${p.id} ORDER BY created_at DESC LIMIT 50`;
  return c.json({ deploys: rows.map((d) => ({ id: d.id, commitSha: d.commit_sha, status: d.status, error: d.error, receipt: d.receipt, createdAt: d.created_at })) });
});

/** Mirrors an already executed protected release action after validating it against Sepolia. */
projects.post("/:id/arkiv-events", async (c) => {
  const p = await owned(c.req.param("id") as string, c.get("user").id);
  if (!p) return c.json({ error: "Project not found" }, 404);
  if (p.mode !== "custom") return c.json({ error: "Arkiv controller events require a protected project" }, 409);
  const { transactionHash } = z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(await c.req.json());
  const source = chain();
  const controller = await readText(source.public, `prod.${p.name}`, "ensure.controller").catch(() => "");
  if (!isAddress(controller)) return c.json({ error: "No valid ENSure controller is set in prod.ensure.controller" }, 409);
  const result = await recordControllerEventFromTransaction({
    projectName: p.name,
    projectNode: namehash(p.name),
    controllerAddress: controller,
    transactionHash: transactionHash as Hex,
  });
  return c.json({ ok: true, entityKey: result.entityKey, duplicate: result.duplicate, arkivTxHash: "txHash" in result ? result.txHash : undefined });
});

/** Quick names only. A protected name rolls back through its owner, not this server. */
projects.post("/:id/rollback", async (c) => {
  const p = await owned(c.req.param("id") as string, c.get("user").id);
  if (!p) return c.json({ error: "Project not found" }, 404);
  if (p.mode !== "quick") return c.json({ error: "This name is protected. Its owner rolls it back on-chain" }, 409);
  const { deployId } = z.object({ deployId: z.string().uuid() }).parse(await c.req.json());
  const [d] = await sql`SELECT receipt FROM deploys WHERE id = ${deployId} AND project_id = ${p.id} AND status = 'live'`;
  if (!d?.receipt) return c.json({ error: "Deploy not found" }, 404);
  const log: string[] = [];
  const txHash = await withChainLock(() => publishName(chain(), p.resolver, p.name, d.receipt, (l) => log.push(l)));
  return c.json({ ok: true, txHash, name: p.name, siteCid: d.receipt.siteCid });
});

/** Config in ENS text records, quick names only. Owners of protected names sign their own. */
projects.post("/:id/records", async (c) => {
  const p = await owned(c.req.param("id") as string, c.get("user").id);
  if (!p) return c.json({ error: "Project not found" }, 404);
  if (p.mode !== "quick") return c.json({ error: "This name is protected. Set records from the owner's wallet" }, 409);
  const { key, value } = z.object({ key: z.string().min(1).max(100), value: z.string().max(2000) }).parse(await c.req.json());
  if (key.startsWith("ensure.")) return c.json({ error: "ensure.* records are managed by deploys" }, 400);
  const client = chain();
  const hash = await withChainLock(async () => {
    const h = await client.wallet.writeContract({ address: p.resolver as Address, abi: resolverAbi, functionName: "setText", args: [dnsEncode(p.name), key, value] });
    const r = await client.public.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error("Record write reverted");
    return h;
  });
  return c.json({ ok: true, txHash: hash });
});

