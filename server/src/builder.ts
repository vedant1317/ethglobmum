// Turns a repo at an exact commit into a folder of static files, with no secrets in the build.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SAFE = /^[A-Za-z0-9._-]+$/;
const safeRelative = (p: string) => p === "" || (p.split("/").every((s) => SAFE.test(s) && s !== ".." && s !== "."));

export type RepoRef = { owner: string; repo: string; branch: string | null; subfolder: string };

export function parseRepoUrl(raw: string): RepoRef {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.hostname !== "github.com") throw new Error("Only https://github.com repositories are supported");
  const [owner, rawRepo, tree, branch, ...rest] = u.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !SAFE.test(owner) || !SAFE.test(repo)) throw new Error("URL must include owner and repository");
  if (tree && tree !== "tree") throw new Error("Unsupported GitHub URL");
  if (branch && !SAFE.test(branch)) throw new Error("Unsupported branch name");
  const subfolder = rest.join("/");
  if (!safeRelative(subfolder)) throw new Error("Unsupported subfolder");
  return { owner, repo, branch: branch ?? null, subfolder };
}

export const checkRelative = (p: string) => { if (!safeRelative(p)) throw new Error(`Unsupported path: ${p}`); };
const remote = (owner: string, repo: string) => `${process.env.GIT_BASE_URL ?? "https://github.com"}/${owner}/${repo}.git`;
const authEnv = (token?: string): Record<string, string> => token
  ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
  : {};

/** The commit a branch currently points at. */
export async function latestSha(owner: string, repo: string, branch: string, token?: string): Promise<string> {
  const { stdout } = await run("git", ["ls-remote", remote(owner, repo), `refs/heads/${branch}`], {
    env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0", ...authEnv(token) },
  });
  const sha = stdout.split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Branch ${branch} not found`);
  return sha;
}

type Step = { script: string; env: Record<string, string>; cache?: boolean; timeoutMs: number };

const sandbox = () => {
  const mode = process.env.BUILD_SANDBOX ?? "docker";
  if (mode === "local" && process.env.NODE_ENV === "production") throw new Error("BUILD_SANDBOX=local isn't allowed in production");
  return mode;
};

/** Runs one step in the sandbox. The child's environment holds only what's passed here. */
function runStep(work: string, step: Step, log: (l: string) => void, redact?: string): Promise<void> {
  const local = sandbox() === "local";
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
  const env = { ...step.env, WORK: local ? work : "/work", CI: "1", NEXT_TELEMETRY_DISABLED: "1", HOME: local ? work : "/tmp" };
  const args = local ? ["-c", step.script] : [
    "run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "--user", `${uid}:${gid}`,
    ...Object.keys(env).flatMap((k) => ["-e", k]), // values come from the child env, never the command line
    "-v", `${work}:/work`, "-w", "/work",
    ...(step.cache ? ["-v", "ensure-npm:/cache/npm", "-v", "ensure-pnpm:/cache/pnpm", "-v", "ensure-yarn:/cache/yarn", "-v", "ensure-corepack:/cache/corepack",
      "-e", "NPM_CONFIG_CACHE=/cache/npm", "-e", "PNPM_STORE_DIR=/cache/pnpm", "-e", "YARN_CACHE_FOLDER=/cache/yarn", "-e", "COREPACK_HOME=/cache/corepack"] : []),
    process.env.BUILDER_IMAGE ?? "ensure-builder", "sh", "-c", step.script,
  ];
  return new Promise((ok, fail) => {
    const child = spawn(local ? "sh" : "docker", args, { cwd: work, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), step.timeoutMs);
    const onData = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) log(redact ? line.replaceAll(redact, "***") : line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? ok() : fail(new Error(`Step failed with exit code ${code}`));
    });
  });
}

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export function detectFramework(pkg: Pkg | null) {
  if (!pkg) return "plain";
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return "next";
  if (deps.vite) return "vite";
  if (deps["react-scripts"]) return "cra";
  return "other";
}

export function detectPackageManager(dir: string) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return { name: "pnpm", install: "corepack pnpm install --frozen-lockfile", build: "corepack pnpm run build" };
  if (existsSync(join(dir, "yarn.lock"))) return { name: "yarn", install: "corepack yarn install --frozen-lockfile", build: "corepack yarn build" };
  if (existsSync(join(dir, "package-lock.json"))) return { name: "npm", install: "npm ci --no-audit --progress=false", build: "npm run build" };
  return { name: "npm", install: "npm install --no-audit --progress=false", build: "npm run build" };
}

const OUTPUT: Record<string, string[]> = { next: ["out"], vite: ["dist"], cra: ["build"], other: ["dist", "build", "out", "public"] };

export type BuildResult = { dir: string; buildTools: Record<string, string>; framework: string; cleanup: () => Promise<void> };

export async function build(i: { owner: string; repo: string; sha: string; subfolder: string; outputDir: string | null; token?: string }, log: (l: string) => void): Promise<BuildResult> {
  checkRelative(i.subfolder);
  if (i.outputDir) checkRelative(i.outputDir);
  const work = await realpath(await mkdtemp(join(tmpdir(), "ensure-build-")));
  const cleanup = () => rm(work, { recursive: true, force: true });
  try {
    log(`Fetching ${i.owner}/${i.repo} at ${i.sha}`);
    await runStep(work, {
      script: `set -eu
git init -q "$WORK/repo"
cd "$WORK/repo"
git -c advice.detachedHead=false fetch -q --depth 1 "$REPO" "$SHA"
git -c advice.detachedHead=false checkout -q FETCH_HEAD
rm -rf .git`,
      env: { REPO: remote(i.owner, i.repo), SHA: i.sha, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:file", ...authEnv(i.token) },
      timeoutMs: 5 * 60_000,
    }, log, i.token);

    const dir = join(work, "repo", i.subfolder);
    if (!existsSync(dir)) throw new Error(`Subfolder not found: ${i.subfolder}`);
    const pkgPath = join(dir, "package.json");
    const pkg: Pkg | null = existsSync(pkgPath) ? JSON.parse(await readFile(pkgPath, "utf8")) : null;
    const framework = detectFramework(pkg);
    log(`Framework: ${framework}`);

    const buildTools: Record<string, string> = {};
    if (pkg) {
      const pm = detectPackageManager(dir);
      buildTools.packageManager = pm.name;
      log(`Package manager: ${pm.name}`);
      if (!pkg.scripts?.build) throw new Error("package.json has no build script");
      // No token and no server secrets here: this runs the repo's own code.
      await runStep(work, {
        script: `set -eu
cd "$WORK/repo/$SUB"
node -v > "$WORK/.node-version"
${pm.install}
${pm.build}`,
        env: { SUB: i.subfolder },
        cache: true,
        timeoutMs: 30 * 60_000,
      }, log);
      buildTools.node = (await readFile(join(work, ".node-version"), "utf8")).trim();
    }

    const candidates = i.outputDir ? [i.outputDir] : pkg ? OUTPUT[framework] : [""];
    const found = candidates.find((c) => existsSync(join(dir, c)));
    if (found === undefined) {
      if (framework === "next") throw new Error('Next.js build produced no "out" folder. Set output: "export" in next.config so it builds static files');
      throw new Error(`No build output found (looked for ${candidates.join(", ")}). Set an output folder on the project`);
    }
    const out = join(dir, found);
    const real = await realpath(out);
    if (real !== resolve(out) && !real.startsWith(join(work, "repo") + sep)) throw new Error("Build output escapes the repo");
    log(`Output: ${found || "."}`);
    return { dir: out, buildTools, framework, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
