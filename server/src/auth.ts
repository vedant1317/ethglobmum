// Login and sessions. Tokens are stored hashed; GitHub tokens are encrypted at rest.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sql } from "./db";

export type User = { id: string; login: string; provider: string; email: string | null };
export type Env = { Variables: { user: User; githubToken: string | null } };

const COOKIE = "ensure_session";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const key = () => createHash("sha256").update(process.env.SESSION_SECRET ?? "").digest();
const webUrl = () => process.env.WEB_URL ?? "http://localhost:5173";
const ghWeb = () => process.env.GITHUB_WEB_URL ?? "https://github.com";
const ghApi = () => process.env.GITHUB_API_URL ?? "https://api.github.com";

export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
export function decrypt(blob: string) {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export async function createSession(userId: string, kind: "web" | "cli", githubToken?: string) {
  const token = randomBytes(32).toString("base64url");
  const days = kind === "web" ? 7 : 90;
  await sql`INSERT INTO sessions (token_hash, user_id, kind, github_token, expires_at)
    VALUES (${hash(token)}, ${userId}, ${kind}, ${githubToken ? encrypt(githubToken) : null}, now() + ${days + " days"}::interval)`;
  return token;
}

const tokenOf = (c: Context) => {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, COOKIE);
};

export async function requireUser(c: Context<Env>, next: Next) {
  const token = tokenOf(c);
  if (!token) return c.json({ error: "Login required" }, 401);
  const [row] = await sql`SELECT u.id, u.login, u.provider, u.email, s.github_token FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash(token)} AND s.expires_at > now()`;
  if (!row) return c.json({ error: "Session expired" }, 401);
  c.set("user", { id: row.id, login: row.login, provider: row.provider, email: row.email });
  c.set("githubToken", row.github_token ? decrypt(row.github_token) : null);
  await next();
}

async function newState(cliPort?: number) {
  const state = randomBytes(24).toString("base64url");
  await sql`INSERT INTO oauth_states (state, cli_port, expires_at) VALUES (${state}, ${cliPort ?? null}, now() + interval '10 minutes')`;
  return state;
}
async function consumeState(state: string | undefined) {
  if (!state) return null;
  const [row] = await sql`DELETE FROM oauth_states WHERE state = ${state} AND expires_at > now() RETURNING cli_port`;
  return row ?? null;
}
async function upsertUser(provider: string, providerId: string, login: string, email: string | null) {
  const [u] = await sql`INSERT INTO users (provider, provider_id, login, email) VALUES (${provider}, ${providerId}, ${login}, ${email})
    ON CONFLICT (provider, provider_id) DO UPDATE SET login = EXCLUDED.login, email = EXCLUDED.email RETURNING id`;
  return u.id as string;
}
const cliPort = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 1023 && n < 65536 ? n : undefined;
};

async function finishLogin(c: Context, userId: string, port: number | null, githubToken?: string) {
  if (port) {
    const token = await createSession(userId, "cli", githubToken);
    return c.redirect(`http://127.0.0.1:${port}/?token=${token}`);
  }
  const token = await createSession(userId, "web", githubToken);
  setCookie(c, COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "Lax", path: "/", maxAge: 7 * 24 * 3600 });
  return c.redirect(`${webUrl()}/dashboard`);
}

export const auth = new Hono<Env>();

auth.get("/github", async (c) => {
  const id = process.env.GITHUB_APP_CLIENT_ID;
  if (!id) return c.json({ error: "GitHub login isn't configured" }, 500);
  const params = new URLSearchParams({ client_id: id, state: await newState(cliPort(c.req.query("cli"))) });
  return c.redirect(`${ghWeb()}/login/oauth/authorize?${params}`);
});

auth.get("/github/callback", async (c) => {
  const state = await consumeState(c.req.query("state"));
  if (!state) return c.json({ error: "Invalid login state" }, 400);
  const res = await fetch(`${ghWeb()}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_APP_CLIENT_ID, client_secret: process.env.GITHUB_APP_CLIENT_SECRET, code: c.req.query("code") }),
  });
  const { access_token: token } = (await res.json()) as any;
  if (!token) return c.json({ error: "GitHub login failed" }, 400);
  const me = (await (await fetch(`${ghApi()}/user`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "ensure" } })).json()) as any;
  if (!me.id) return c.json({ error: "GitHub login failed" }, 400);
  return finishLogin(c, await upsertUser("github", String(me.id), me.login, me.email ?? null), state.cli_port, token);
});

auth.get("/google", async (c) => {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) return c.json({ error: "Google login isn't configured" }, 500);
  const params = new URLSearchParams({
    client_id: id, redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`, response_type: "code",
    scope: "openid email profile", state: await newState(cliPort(c.req.query("cli"))),
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

auth.get("/google/callback", async (c) => {
  const state = await consumeState(c.req.query("state"));
  if (!state) return c.json({ error: "Invalid login state" }, 400);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      code: c.req.query("code") ?? "", grant_type: "authorization_code", redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`,
    }),
  });
  const { access_token: token } = (await res.json()) as any;
  if (!token) return c.json({ error: "Google login failed" }, 400);
  const me = (await (await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
  if (!me.id) return c.json({ error: "Google login failed" }, 400);
  return finishLogin(c, await upsertUser("google", String(me.id), me.email.split("@")[0], me.email), state.cli_port);
});

auth.get("/me", requireUser, (c) => c.json({ user: c.get("user") }));

auth.post("/logout", requireUser, async (c) => {
  await sql`DELETE FROM sessions WHERE token_hash = ${hash(tokenOf(c)!)}`;
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.post("/cli-token", requireUser, async (c) => c.json({ token: await createSession(c.get("user").id, "cli", c.get("githubToken") ?? undefined) }));

auth.post("/telegram-code", requireUser, async (c) => {
  const code = randomBytes(4).toString("hex");
  await sql`INSERT INTO link_codes (code, user_id, expires_at) VALUES (${code}, ${c.get("user").id}, now() + interval '10 minutes')`;
  return c.json({ code });
});
