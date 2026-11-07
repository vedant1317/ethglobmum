import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL ?? "", { onnotice: () => {} });

export async function migrate() {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)`;
  const dir = join(import.meta.dirname, "../migrations");
  for (const name of (await readdir(dir)).sort()) {
    if ((await sql`SELECT 1 FROM schema_migrations WHERE name = ${name}`).length) continue;
    const text = await readFile(join(dir, name), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
  }
}
