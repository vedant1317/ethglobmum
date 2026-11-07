import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { auth, type Env } from "./auth";
import { startBot } from "./bot";
import { migrate } from "./db";
import { deploys, startWorker } from "./deploys";
import { github } from "./github";
import { names } from "./names";
import { projects } from "./projects";

const REQUIRED = ["DATABASE_URL", "SESSION_SECRET", "SEPOLIA_RPC_URL", "PUBLISHER_PRIVATE_KEY", "PINATA_JWT", "PLATFORM_NAME", "PLATFORM_REGISTRY", "PLATFORM_RESOLVER"];

export function createApp() {
  const app = new Hono<Env>();
  app.use(cors({ origin: (process.env.WEB_URL ?? "http://localhost:5173").split(","), credentials: true }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/auth", auth);
  app.route("/github", github);
  app.route("/names", names);
  app.route("/projects", projects);
  app.route("/deploys", deploys);
  app.onError((e: any, c) => {
    if (e instanceof ZodError) return c.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    if (e.status) return c.json({ error: e.message }, e.status);
    console.error(e);
    return c.json({ error: "Internal error" }, 500);
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  await migrate();
  await startWorker();
  startBot();
  const port = Number(process.env.PORT ?? 3001);
  serve({ fetch: createApp().fetch, port });
  console.log(`ENSure API on http://localhost:${port}`);
}
