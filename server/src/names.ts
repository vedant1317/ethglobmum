// Quick-name generation, and proof that a wallet owns a custom name.
import { randomBytes, randomInt } from "node:crypto";
import { Hono } from "hono";
import { getAddress, isAddress, type Hex } from "viem";
import { z } from "zod";
import { findOwner, registryAbi } from "@ensure/core/ens";
import { requireUser, type Env } from "./auth";
import { sql } from "./db";
import { chain } from "./deploys";

const ADJECTIVES = ["amber", "azure", "bold", "brisk", "calm", "crisp", "eager", "gentle", "golden", "lunar", "misty", "noble", "rapid", "silver", "solar", "swift", "wild"];
const NOUNS = ["anchor", "beacon", "comet", "falcon", "forge", "harbor", "lotus", "maple", "nova", "oasis", "otter", "river", "sparrow", "summit", "tiger", "valley"];
const pick = (a: string[]) => a[randomInt(a.length)];

export const NAME = /^[a-z0-9-]+\.eth$/;

export async function generateQuickName(): Promise<string> {
  const parent = process.env.PLATFORM_NAME;
  if (!parent) throw new Error("PLATFORM_NAME isn't configured");
  const c = chain();
  for (let i = 0; i < 5; i++) {
    const label = `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(2).toString("hex")}`;
    const resolver = await c.public.readContract({ address: process.env.PLATFORM_REGISTRY as Hex, abi: registryAbi, functionName: "getResolver", args: [label] });
    if (/^0x0+$/.test(resolver)) return `${label}.${parent}`;
  }
  throw new Error("Couldn't find a free quick name");
}

export const names = new Hono<Env>();

names.post("/custom/challenge", requireUser, async (c) => {
  const body = z.object({ name: z.string().regex(NAME), wallet: z.string().refine(isAddress) }).parse(await c.req.json());
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + 10 * 60_000);
  const wallet = getAddress(body.wallet);
  const message = `ENSure name ownership\nName: ${body.name}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${expires.toISOString()}`;
  await sql`INSERT INTO name_challenges (nonce, name, wallet, message, user_id, expires_at) VALUES (${nonce}, ${body.name}, ${wallet}, ${message}, ${c.get("user").id}, ${expires})`;
  return c.json({ nonce, message });
});

names.post("/custom/verify", requireUser, async (c) => {
  const body = z.object({ nonce: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
  const [ch] = await sql`SELECT * FROM name_challenges WHERE nonce = ${body.nonce} AND user_id = ${c.get("user").id} AND expires_at > now() AND verified_at IS NULL`;
  if (!ch) return c.json({ error: "Challenge not found or expired" }, 404);
  const { public: client } = chain();
  // Works for wallets and contract accounts such as a Safe.
  const signed = await client.verifyMessage({ address: ch.wallet, message: ch.message, signature: body.signature as Hex });
  if (!signed) return c.json({ error: "Signature doesn't match the wallet" }, 401);
  const owner = await findOwner(client, ch.name);
  if (getAddress(owner) !== getAddress(ch.wallet)) return c.json({ error: `That wallet doesn't own ${ch.name}` }, 403);
  await sql`UPDATE name_challenges SET verified_at = now() WHERE nonce = ${body.nonce}`;
  return c.json({ ok: true, name: ch.name, wallet: ch.wallet });
});

export const isVerified = async (name: string, userId: string) =>
  (await sql`SELECT 1 FROM name_challenges WHERE name = ${name} AND user_id = ${userId} AND verified_at IS NOT NULL`).length > 0;

