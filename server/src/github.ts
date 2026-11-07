// GitHub API: repo access, App installation tokens, and the push webhook.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { requireUser, type Env } from "./auth";
import { sql } from "./db";
import { createDeploy } from "./deploys";

const api = () => process.env.GITHUB_API_URL ?? "https://api.github.com";

async function gh(path: string, token?: string | null, init: RequestInit = {}) {
  return fetch(`${api()}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ensure", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
}

export type RepoInfo = { id: string; private: boolean; defaultBranch: string };

/** Confirms this user may deploy the repo. Private repos need the user's own token to see them. */
export async function repoAccess(owner: string, repo: string, userToken: string | null): Promise<RepoInfo> {
  const res = await gh(`/repos/${owner}/${repo}`, userToken);
  if (!res.ok) throw Object.assign(new Error(`Repo ${owner}/${repo} not found, or you don't have access`), { status: 403 });
  const r = (await res.json()) as any;
  return { id: String(r.id), private: r.private, defaultBranch: r.default_branch };
}

function appJwt() {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID })}`;
  const key = (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

/** A short-lived token scoped to one repo, for cloning. */
export async function installationToken(owner: string, repo: string): Promise<string> {
  const jwt = appJwt();
  const inst = await gh(`/repos/${owner}/${repo}/installation`, jwt);
  if (!inst.ok) throw new Error(`Install the GitHub App on ${owner}/${repo} to deploy this private repo`);
  const { id } = (await inst.json()) as any;
  const res = await gh(`/app/installations/${id}/access_tokens`, jwt, {
    method: "POST", body: JSON.stringify({ repositories: [repo], permissions: { contents: "read" } }),
  });
  if (!res.ok) throw new Error(`Couldn't get a token for ${owner}/${repo}: ${res.status}`);
  return ((await res.json()) as any).token;
}

export function validSignature(secret: string, raw: Buffer, header: string | undefined) {
  if (!header) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const github = new Hono<Env>();

github.get("/repos", requireUser, async (c) => {
  const token = c.get("githubToken");
  if (!token) return c.json({ error: "Log in with GitHub to list repos" }, 403);
  const res = await gh("/user/repos?per_page=100&sort=updated", token);
  if (!res.ok) return c.json({ error: "GitHub session expired. Log in again" }, 401);
  const repos = (await res.json()) as any[];
  return c.json({ repos: repos.map((r) => ({ id: String(r.id), fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })) });
});

github.get("/repos/:owner/:repo/branches", requireUser, async (c) => {
  const res = await gh(`/repos/${c.req.param("owner")}/${c.req.param("repo")}/branches?per_page=100`, c.get("githubToken"));
  if (!res.ok) return c.json({ error: "Repo not found" }, 404);
  return c.json({ branches: ((await res.json()) as any[]).map((b) => b.name) });
});

github.post("/webhook", async (c) => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (!validSignature(process.env.GITHUB_WEBHOOK_SECRET ?? "", raw, c.req.header("x-hub-signature-256"))) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  if (c.req.header("x-github-event") !== "push") return c.json({ skipped: true });
  const delivery = c.req.header("x-github-delivery");
  if (delivery) {
    const fresh = await sql`INSERT INTO webhook_deliveries (id) VALUES (${delivery}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!fresh.length) return c.json({ skipped: true, reason: "duplicate" });
  }
  const push = JSON.parse(raw.toString());
  const branch = String(push.ref ?? "").replace("refs/heads/", "");
  const sha = String(push.after ?? "");
  if (!/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha)) return c.json({ skipped: true, reason: "no commit" });
  const projects = await sql`SELECT id FROM projects WHERE repo_id = ${String(push.repository?.id)} AND branch = ${branch}`;
  const deploys = [];
  for (const p of projects) deploys.push(await createDeploy(p.id, { commitSha: sha }));
  return c.json({ deploys }, 202);
});
