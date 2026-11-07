import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "public");
const dist = join(root, "dist");

// Prefer public/ as the source; if only dist/ exists (checked-in static build), validate it.
if (existsSync(src)) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const name of readdirSync(src)) {
    cpSync(join(src, name), join(dist, name), { recursive: true });
  }
}

if (!existsSync(join(dist, "index.html"))) {
  console.error("site build: missing dist/index.html");
  process.exit(1);
}
console.log(`site build: ${readdirSync(dist).length} files in dist/`);
