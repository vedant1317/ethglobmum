// Telegram: guided and paste-a-URL deploys, with optional AI help. Off unless TELEGRAM_BOT_TOKEN is set.
import { Bot, type Context } from "grammy";
import { z } from "zod";
import { sql } from "./db";
import { createDeploy } from "./deploys";
import { createProject } from "./projects";

const GITHUB_URL = /https:\/\/github\.com\/[^\s)]+/i;

export type Plan = { repoUrl: string; name?: string };

/** Regex fallback, used whenever the LLM is off or returns something invalid. */
export function fallbackPlan(text: string): Plan | null {
  const url = text.match(GITHUB_URL)?.[0].replace(/[),.;!?]+$/, "");
  if (!url) return null;
  const name = text.replace(url, "").match(/\b[a-z0-9-]+\.eth\b/i)?.[0].toLowerCase();
  return { repoUrl: url, name };
}

const PlanSchema = z.object({ repoUrl: z.string().url().regex(/^https:\/\/github\.com\//), name: z.string().regex(/^[a-z0-9-]+\.eth$/).nullish() });

export function parsePlan(llmOutput: string, text: string): Plan | null {
  try {
    const p = PlanSchema.parse(JSON.parse(llmOutput));
    // The repo must be one the user actually wrote: LLM output is untrusted.
    if (!text.includes(p.repoUrl.replace(/\.git$/, ""))) return fallbackPlan(text);
    return { repoUrl: p.repoUrl, name: p.name ?? undefined };
  } catch {
    return fallbackPlan(text);
  }
}

async function llm(system: string, user: string, json = false) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL ?? "openrouter/auto",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return ((await res.json()) as any).choices?.[0]?.message?.content ?? null;
}

async function planDeploy(text: string): Promise<Plan | null> {
  const out = await llm('Extract a deploy request. Reply with JSON only: {"repoUrl": a github.com URL from the message, "name": an .eth name from the message or null}.', text, true).catch(() => null);
  return out ? parsePlan(out, text) : fallbackPlan(text);
}

const linkedUser = async (ctx: Context) => {
  const [u] = await sql`SELECT id FROM users WHERE telegram_id = ${ctx.from!.id}`;
  return u?.id as string | undefined;
};

/** Sends logs as one message, edited at most every 2 seconds, to stay within rate limits. */
async function streamDeploy(ctx: Context, deployId: string) {
  const sent = await ctx.reply("Deploy queued...");
  let seq = 0, last = "";
  const lines: string[] = [];
  while (true) {
    const rows = await sql`SELECT seq, line FROM deploy_logs WHERE deploy_id = ${deployId} AND seq > ${seq} ORDER BY seq`;
    for (const r of rows) { seq = Number(r.seq); lines.push(r.line); }
    const text = lines.slice(-15).join("\n").slice(-3500) || "Deploy queued...";
    if (text !== last) { await ctx.api.editMessageText(ctx.chat!.id, sent.message_id, text).catch(() => {}); last = text; }
    const [d] = await sql`SELECT status, error, receipt FROM deploys WHERE id = ${deployId}`;
    if (["live", "preview", "built", "superseded", "failed"].includes(d.status)) {
      if (d.status === "failed") return void ctx.reply(`Deploy failed: ${d.error}`);
      if (d.receipt) return void ctx.reply(`${d.status === "live" ? "Live" : "On preview"}: ${d.receipt.name}\nCID: ${d.receipt.siteCid}\n${d.receipt.url}`);
      return void ctx.reply(`Finished: ${d.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function deployFromPlan(ctx: Context, userId: string, plan: Plan) {
  try {
    // Bot deploys have no GitHub user token, so they cover public repos.
    const project = await createProject({ id: userId, githubToken: null }, plan);
    await ctx.reply(`Deploying ${project.repoUrl} to ${project.previewName ?? project.name}`);
    const deploy = await createDeploy(project.id);
    await streamDeploy(ctx, deploy.id);
  } catch (e) {
    await ctx.reply(`Couldn't deploy: ${(e as Error).message}`);
  }
}

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const bot = new Bot(token);
  const awaitingRepo = new Set<number>();
  const help = "Paste a GitHub URL to deploy it.\n/deploy guided deploy\n/status running deploys\n/link <code> link your account\n/cancel";

  bot.command(["start", "help"], (ctx) => ctx.reply(help));

  bot.command("link", async (ctx) => {
    const [row] = await sql`DELETE FROM link_codes WHERE code = ${ctx.match.trim()} AND expires_at > now() RETURNING user_id`;
    if (!row) return ctx.reply("That code isn't valid or has expired.");
    await sql`UPDATE users SET telegram_id = ${ctx.from!.id} WHERE id = ${row.user_id}`;
    return ctx.reply("Linked. Paste a GitHub URL to deploy.");
  });

  bot.command("status", async (ctx) => {
    const userId = await linkedUser(ctx);
    if (!userId) return ctx.reply("Link your account first with /link.");
    const rows = await sql`SELECT d.status, p.name FROM deploys d JOIN projects p ON p.id = d.project_id WHERE p.user_id = ${userId} ORDER BY d.created_at DESC LIMIT 5`;
    return ctx.reply(rows.map((r) => `${r.name}: ${r.status}`).join("\n") || "No deploys yet.");
  });

  bot.command("deploy", async (ctx) => {
    if (!(await linkedUser(ctx))) return ctx.reply("Link your account first with /link.");
    awaitingRepo.add(ctx.chat.id);
    return ctx.reply("Send the GitHub URL.");
  });

  bot.command("cancel", (ctx) => { awaitingRepo.delete(ctx.chat.id); return ctx.reply("Cancelled."); });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const userId = await linkedUser(ctx);
    if (GITHUB_URL.test(text)) {
      awaitingRepo.delete(ctx.chat.id);
      if (!userId) return ctx.reply("Link your account first with /link, so a stranger can't spend your gas.");
      const plan = await planDeploy(text);
      if (!plan) return ctx.reply("I couldn't read a GitHub URL there.");
      void deployFromPlan(ctx, userId, plan);
      return;
    }
    if (awaitingRepo.has(ctx.chat.id)) return ctx.reply("That isn't a GitHub URL. Try again, or /cancel.");
    const answer = await llm("You help users of ENSure, which deploys websites from GitHub to IPFS under ENS names. Be brief.", text).catch(() => null);
    return ctx.reply(answer ?? help);
  });

  bot.catch((e) => console.error("[bot]", e.message));
  void bot.start();
  return bot;
}
