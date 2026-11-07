// Full base flow: real ENSv2 contracts on a Sepolia fork, real Postgres, real git, real builds, real API and CLI.
// Needs ANVIL_BIN, FORGE_BIN and network access. Run: pnpm e2e
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, namehash, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { REGISTRY_ROLES, RESOLVER_ROLES, SEPOLIA, decodeContenthash, dnsEncode, findOwner, findResolver, labelId, readContenthash, readText, registryAbi, resolverAbi, sameCid, withAdmin } from "@ensure/core/ens";
import { allowLogging, setupPlatform, setupProject, signerFrom } from "@ensure/core/setup";
import { parseManifest } from "@ensure/core/manifest";
import { startStubs } from "./stubs";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const { ANVIL_BIN, FORGE_BIN } = process.env;
const FORK = process.env.E2E_FORK_URL ?? "https://ethereum-sepolia.publicnode.com";
const PORTS = { anvil: 58545, pg: 55432, stub: 58100, api: 58200 };
const RPC = `http://127.0.0.1:${PORTS.anvil}`;
const STUB = `http://127.0.0.1:${PORTS.stub}`;
const API = `http://127.0.0.1:${PORTS.api}`;
// Fresh keys: anvil's well-known dev keys have code on real Sepolia, so they can't receive ERC-1155 tokens.
const SECRET_KEY = generatePrivateKey();
const OWNER_KEY = generatePrivateKey();
const STRANGER_KEY = generatePrivateKey();
const WEBHOOK_SECRET = "webhook-secret-e2e";
const PINATA_JWT = "pinata-jwt-e2e-do-not-leak";

const owner = privateKeyToAccount(OWNER_KEY);
const publisher = privateKeyToAccount(SECRET_KEY);
const stranger = privateKeyToAccount(STRANGER_KEY);

const tmp = mkdtempSync(join(tmpdir(), "ensure-e2e-"));
const procs: ChildProcess[] = [];
let stubs: Awaited<ReturnType<typeof startStubs>>;
let stopWorker: () => void;
let stopServer: () => void;
let session = "";
let cliToken = "";

const client = createPublicClient({ chain: sepolia, transport: http(RPC, { timeout: 60_000 }) });
const test = createTestClient({ chain: sepolia, mode: "anvil", transport: http(RPC, { timeout: 60_000 }) });
const walletOf = (account: any) => createWalletClient({ chain: sepolia, transport: http(RPC, { timeout: 60_000 }), account });
const signer = (account: any) => signerFrom({ public: client, wallet: walletOf(account) as any, account: account.address });

const suffix = Date.now().toString(36);
const PLATFORM = `ensplat${suffix}.eth`;
const PROJECT = `ensproj${suffix}.eth`;
const UNSET = `ensunset${suffix}.eth`;

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, env: { PATH: process.env.PATH, HOME: tmp, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

async function makeRepo(name: string, files: Record<string, string>, id: number, isPrivate = false) {
  const dir = join(tmp, "gh", "acme", `${name}.git`);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeAll(dir, files);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
  stubs.repos.set(`acme/${name}`, { id, private: isPrivate, default_branch: "main" });
  return dir;
}
function writeAll(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}
async function commit(dir: string, files: Record<string, string>) {
  writeAll(dir, files);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "change");
  return (await git(dir, "rev-parse", "HEAD")).stdout.trim();
}

async function call(path: string, init: Omit<RequestInit, "body"> & { body?: any } = {}, cookie = session) {
  const res = await fetch(`${API}${path}`, {
    ...init, redirect: "manual",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: `ensure_session=${cookie}` } : {}), ...init.headers },
    body: init.body && typeof init.body !== "string" ? JSON.stringify(init.body) : init.body,
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, res };
}

async function waitDeploy(id: string, timeoutMs = 280_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { json } = await call(`/deploys/${id}`);
    if (["live", "preview", "built", "superseded", "failed"].includes(json.deploy.status)) return json.deploy;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`deploy ${id} timed out`);
}

const logsOf = async (id: string) => {
  const res = await fetch(`${API}/deploys/${id}/events`, { headers: { Cookie: `ensure_session=${session}` } });
  return res.text();
};

const cli = (cwd: string, ...args: string[]) => run(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "cli/src/index.ts"), ...args], {
  cwd, env: { PATH: process.env.PATH, HOME: tmp, ENSURE_API: API, ENSURE_TOKEN: cliToken, SEPOLIA_RPC_URL: RPC },
});

async function registerParent(label: string) {
  // On a fork we can act as the registrar. Live, register the parent in the ENS app.
  await test.impersonateAccount({ address: SEPOLIA.ethRegistrar });
  await test.setBalance({ address: SEPOLIA.ethRegistrar, value: 10n ** 18n });
  const G = REGISTRY_ROLES;
  const bitmap = withAdmin(G.SET_SUBREGISTRY, G.SET_RESOLVER) | ((1n << 28n) << 128n);
  const hash = await walletOf(SEPOLIA.ethRegistrar).writeContract({
    address: SEPOLIA.ethRegistry, abi: registryAbi, functionName: "register", account: SEPOLIA.ethRegistrar,
    args: [label, owner.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", bitmap, BigInt(Math.floor(Date.now() / 1000) + 365 * 86400)],
  });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`parent registration reverted: ${label}`);
  await test.stopImpersonatingAccount({ address: SEPOLIA.ethRegistrar });
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const SITE = { "index.html": "<!doctype html><title>plain</title><p>v1</p>", "assets/app.js": "console.log(1)" };
let plainDir: string;
let protectedDir: string;
let quick: any, firstQuickDeploy: any, secondQuickDeploy: any, custom: any, deployRegistry: Address;

describe("base feature end to end", () => {
  beforeAll(async () => {
    if (!ANVIL_BIN || !FORGE_BIN) throw new Error("Set ANVIL_BIN and FORGE_BIN");

    const pgData = join(tmp, "pg");
    await run("initdb", ["-D", pgData, "-U", "ensure", "--auth=trust", "-E", "UTF8"]);
    await run("pg_ctl", ["-D", pgData, "-o", `-p ${PORTS.pg} -k ${tmp} -c listen_addresses=127.0.0.1`, "-w", "-l", join(tmp, "pg.log"), "start"]);
    await run("createdb", ["-h", "127.0.0.1", "-p", String(PORTS.pg), "-U", "ensure", "ensure"]);

    // A few blocks back: load-balanced public RPCs may not all have the newest block yet.
    const head = await createPublicClient({ chain: sepolia, transport: http(FORK) }).getBlockNumber();
    const anvil = spawn(ANVIL_BIN, ["--fork-url", FORK, "--fork-block-number", String(head - 20n), "--port", String(PORTS.anvil), "--silent"], { stdio: "ignore" });
    procs.push(anvil);
    await waitFor(async () => (await client.getChainId()) === 11155111, "anvil fork", 90_000);

    for (const a of [owner, publisher, stranger]) await test.setBalance({ address: a.address, value: 10n ** 19n });

    stubs = await startStubs(PORTS.stub, { privatePinJwt: PINATA_JWT });

    await run(FORGE_BIN, ["build", "--root", join(ROOT, "contracts")]);
    const artifact = JSON.parse(readFileSync(join(ROOT, "contracts/out/DeployRegistry.sol/DeployRegistry.json"), "utf8"));
    const wallet = walletOf(owner);
    const receipt = await client.waitForTransactionReceipt({ hash: await (wallet as any).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [SEPOLIA.universalHelper] }) });
    deployRegistry = receipt.contractAddress!;

    await registerParent(PLATFORM.split(".")[0]);
    await registerParent(PROJECT.split(".")[0]);
    await registerParent(UNSET.split(".")[0]);

    const platform = await setupPlatform(signer(owner), PLATFORM, publisher.address);
    const project = await setupProject(signer(owner), PROJECT, publisher.address);
    await allowLogging(signer(owner), deployRegistry, project.previewName, publisher.address);
    custom = { ...project };

    Object.assign(process.env, {
      DATABASE_URL: `postgres://ensure@127.0.0.1:${PORTS.pg}/ensure`, SESSION_SECRET: "session-secret-e2e", SEPOLIA_RPC_URL: RPC,
      PUBLISHER_PRIVATE_KEY: SECRET_KEY, PINATA_JWT, PLATFORM_NAME: PLATFORM, PLATFORM_REGISTRY: platform.registry, PLATFORM_RESOLVER: platform.resolver,
      PINATA_API_URL: STUB, PINATA_UPLOADS_URL: STUB, IPFS_GATEWAYS: STUB, IPFS_RETRY_MS: "20", GITHUB_API_URL: STUB, GITHUB_WEB_URL: STUB,
      GITHUB_APP_ID: "1", GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "client-secret", GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GIT_BASE_URL: `file://${join(tmp, "gh")}`, BUILD_SANDBOX: "local", DEPLOY_REGISTRY: deployRegistry, API_URL: API, WEB_URL: "http://web.test", MAX_CONCURRENT_DEPLOYS: "2",
    });
    const { generateKeyPairSync } = await import("node:crypto");
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const { migrate } = await import("../src/db");
    await migrate();
    const { createApp } = await import("../src/index");
    const { startWorker } = await import("../src/deploys");
    const { serve } = await import("@hono/node-server");
    const srv = serve({ fetch: createApp().fetch, port: PORTS.api });
    stopServer = () => srv.close();
    stopWorker = await startWorker(2, 200);

    plainDir = await makeRepo("plain", SITE, 1001);
  });

  afterAll(async () => {
    stopWorker?.();
    stopServer?.();
    stubs?.close();
    for (const p of procs) p.kill("SIGKILL");
    const { sql } = await import("../src/db");
    await sql.end({ timeout: 1 }).catch(() => {});
    await run("pg_ctl", ["-D", join(tmp, "pg"), "-m", "immediate", "stop"]).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("setup on real ENSv2 contracts", () => {
    it("preview and prod are ERC-1155 tokens the owner holds", async () => {
      expect(await findOwner(client, custom.previewName)).toBe(owner.address);
      expect(await findOwner(client, custom.prodName)).toBe(owner.address);
      const tokenId = await client.readContract({ address: custom.registry, abi: registryAbi, functionName: "getTokenId", args: [labelId("prod")] });
      expect(await client.readContract({ address: custom.registry, abi: registryAbi, functionName: "ownerOf", args: [tokenId] })).toBe(owner.address);
    });
    it("names route to separate resolvers", async () => {
      expect((await findResolver(client, custom.previewName)).toLowerCase()).toBe(custom.previewResolver.toLowerCase());
      expect((await findResolver(client, custom.prodName)).toLowerCase()).toBe(custom.prodResolver.toLowerCase());
      expect(custom.previewResolver).not.toBe(custom.prodResolver);
    });
    it("the publisher has preview rights and no production rights", async () => {
      const has = (r: Address, role: bigint) => client.readContract({ address: r, abi: resolverAbi, functionName: "hasRootRoles", args: [role, publisher.address] });
      expect(await has(custom.previewResolver, RESOLVER_ROLES.SET_CONTENTHASH)).toBe(true);
      expect(await has(custom.prodResolver, RESOLVER_ROLES.SET_CONTENTHASH)).toBe(false);
    });
    it("a prod write by the publisher really reverts", async () => {
      await expect(client.simulateContract({
        address: custom.prodResolver, abi: resolverAbi, functionName: "setContenthash", account: publisher,
        args: [dnsEncode(custom.prodName), "0xe301"],
      })).rejects.toThrow(/EACUnauthorizedAccountRoles|reverted|0x[0-9a-f]{8}/);
    });
    it("the prod token can't be transferred", async () => {
      const tokenId = await client.readContract({ address: custom.registry, abi: registryAbi, functionName: "getTokenId", args: [labelId("prod")] });
      await expect(client.simulateContract({
        address: custom.registry, abi: [{ type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [{ type: "address", name: "from" }, { type: "address", name: "to" }, { type: "uint256", name: "id" }, { type: "uint256", name: "value" }, { type: "bytes", name: "data" }], outputs: [] }],
        functionName: "safeTransferFrom", account: owner, args: [owner.address, stranger.address, tokenId, 1n, "0x"],
      })).rejects.toThrow();
    });
  });

  describe("login", () => {
    it("refuses protected routes without a session", async () => {
      expect((await call("/projects", {}, "")).status).toBe(401);
      expect((await call("/auth/me", {}, "bogus")).status).toBe(401);
    });
    it("rejects a bad OAuth state", async () => {
      expect((await call("/auth/github/callback?state=nope&code=x", {}, "")).status).toBe(400);
    });
    it("GitHub login sets an HTTP-only cookie and no token in the URL", async () => {
      const start = await call("/auth/github", {}, "");
      expect(start.status).toBe(302);
      const state = new URL(start.res.headers.get("location")!).searchParams.get("state")!;
      const done = await call(`/auth/github/callback?state=${state}&code=abc`, {}, "");
      expect(done.status).toBe(302);
      expect(done.res.headers.get("location")).toBe("http://web.test/dashboard");
      const cookie = done.res.headers.get("set-cookie")!;
      expect(cookie).toMatch(/HttpOnly/i);
      session = cookie.match(/ensure_session=([^;]+)/)![1];
      expect((await call("/auth/me")).json.user.login).toBe("alice");
      expect((await call(`/auth/github/callback?state=${state}&code=abc`, {}, "")).status).toBe(400); // state is single use
    });
    it("stores the GitHub token encrypted, and the session hashed", async () => {
      const { sql } = await import("../src/db");
      const [s] = await sql`SELECT token_hash, github_token FROM sessions LIMIT 1`;
      expect(s.token_hash).not.toBe(session);
      expect(s.github_token).not.toContain("user-token-1");
    });
    it("issues a CLI token", async () => {
      const { status, json } = await call("/auth/cli-token", { method: "POST" });
      expect(status).toBe(200);
      cliToken = json.token;
      const res = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${cliToken}` } });
      expect(res.status).toBe(200);
    });
    it("lists repos and branches", async () => {
      expect((await call("/github/repos")).json.repos[0].fullName).toBe("acme/plain");
      expect((await call("/github/repos/acme/plain/branches")).json.branches).toContain("main");
    });
  });

  describe("quick deploy", () => {
    it("goes from a repo URL to a live ENS name", async () => {
      const { status, json } = await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/plain", deploy: true } });
      expect(status).toBe(201);
      quick = json.project;
      expect(quick.name).toMatch(new RegExp(`^[a-z]+-[a-z]+-[0-9a-f]{4}\\.${PLATFORM.replace(".", "\\.")}$`));
      firstQuickDeploy = await waitDeploy(json.deploy.id);
      expect(firstQuickDeploy.error).toBeNull();
      expect(firstQuickDeploy.status).toBe("live");
    });
    it("the name really serves the pinned site, read from chain", async () => {
      const r = firstQuickDeploy.receipt;
      const { contenthash } = await readContenthash(client, quick.name);
      expect(contenthash).toBe(r.contenthash);
      expect(sameCid(decodeContenthash(contenthash), r.siteCid)).toBe(true);
      expect(await readText(client, quick.name, "ensure.manifest")).toBe(r.manifestCid);
    });
    it("files are fetchable by CID, and match the manifest", async () => {
      const r = firstQuickDeploy.receipt;
      const html = await (await fetch(`${STUB}/ipfs/${r.siteCid}/index.html`)).text();
      expect(html).toBe(SITE["index.html"]);
      const manifest = parseManifest(new Uint8Array(await (await fetch(`${STUB}/ipfs/${r.manifestCid}`)).arrayBuffer()));
      expect(manifest.siteCid).toBe(r.siteCid);
      expect(manifest.commitSha).toBe(r.commitSha);
      expect(manifest.files.map((f) => f.path)).toEqual(["assets/app.js", "index.html"]);
      expect(stubs.pinataNetworks.every((n) => n === "public")).toBe(true);
    });
    it("streams logs over SSE, ending in done", async () => {
      const text = await logsOf(firstQuickDeploy.id);
      expect(text).toContain("event: stage");
      expect(text).toContain("Site CID");
      expect(text).toContain("event: done");
    });
    it("writes the on-chain deploy log", async () => {
      expect(firstQuickDeploy.receipt.logTxHash).toMatch(/^0x/);
      const count = await client.readContract({ address: deployRegistry, abi: [{ type: "function", name: "deployCount", stateMutability: "view", inputs: [{ type: "bytes32", name: "n" }], outputs: [{ type: "uint256" }] }], functionName: "deployCount", args: [namehash(quick.name)] });
      expect(count).toBe(1n);
    });
    it("a push deploys the exact pushed SHA, once", async () => {
      const sha = await commit(plainDir, { "index.html": "<!doctype html><p>v2</p>" });
      const body = JSON.stringify({ ref: "refs/heads/main", after: sha, repository: { id: 1001 } });
      const sign = (b: string, s = WEBHOOK_SECRET) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;
      const send = (sig: string, delivery: string, event = "push") => fetch(`${API}/github/webhook`, { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": event, "x-github-delivery": delivery } });
      expect((await send(sign(body, "wrong"), "d1")).status).toBe(401);
      const ok = await send(sign(body), "d2");
      expect(ok.status).toBe(202);
      const { deploys } = (await ok.json()) as any;
      expect(deploys).toHaveLength(1);
      expect(((await (await send(sign(body), "d2")).json()) as any).reason).toBe("duplicate");
      expect(((await (await send(sign(body), "d3", "ping")).json()) as any).skipped).toBe(true);
      secondQuickDeploy = await waitDeploy(deploys[0].id);
      expect(secondQuickDeploy.status).toBe("live");
      expect(secondQuickDeploy.commitSha).toBe(sha);
      expect((await readContenthash(client, quick.name)).contenthash).toBe(secondQuickDeploy.receipt.contenthash);
    });
    it("a stale commit doesn't overwrite a newer one", async () => {
      const { json } = await call("/deploys", { method: "POST", body: { projectId: quick.id, commitSha: firstQuickDeploy.commitSha } });
      const d = await waitDeploy(json.deploy.id);
      expect(d.status).toBe("superseded");
      expect((await readContenthash(client, quick.name)).contenthash).toBe(secondQuickDeploy.receipt.contenthash);
    });
    it("rolls back without a rebuild", async () => {
      const { status } = await call(`/projects/${quick.id}/rollback`, { method: "POST", body: { deployId: firstQuickDeploy.id } });
      expect(status).toBe(200);
      expect((await readContenthash(client, quick.name)).contenthash).toBe(firstQuickDeploy.receipt.contenthash);
    });
    it("dry run stops before pinning and writes nothing", async () => {
      const before = stubs.calls.filter((c) => c.includes("pinFileToIPFS")).length;
      const { json } = await call("/deploys", { method: "POST", body: { projectId: quick.id, dryRun: true } });
      const d = await waitDeploy(json.deploy.id);
      expect(d.status).toBe("built");
      expect(stubs.calls.filter((c) => c.includes("pinFileToIPFS")).length).toBe(before);
    });
    it("stores config in ENS text records, and protects ensure.*", async () => {
      expect((await call(`/projects/${quick.id}/records`, { method: "POST", body: { key: "deploy.framework", value: "plain" } })).status).toBe(200);
      expect(await readText(client, quick.name, "deploy.framework")).toBe("plain");
      expect((await call(`/projects/${quick.id}/records`, { method: "POST", body: { key: "ensure.manifest", value: "x" } })).status).toBe(400);
    });
  });

  describe("builds", () => {
    const deployRepo = async (name: string, files: Record<string, string>, id: number, extra: object = {}) => {
      await makeRepo(name, files, id);
      const { json } = await call("/projects", { method: "POST", body: { repoUrl: `https://github.com/acme/${name}`, deploy: true, ...extra } });
      return { project: json.project, deploy: await waitDeploy(json.deploy.id) };
    };

    it("build scripts can't see server secrets", async () => {
      const { deploy } = await deployRepo("snoop", {
        "package.json": JSON.stringify({ scripts: { build: "mkdir -p dist && cp index.html dist/ && env > dist/env.txt && env" } }),
        "index.html": "<p>x</p>",
      }, 2001);
      expect(deploy.status).toBe("live");
      const env = await (await fetch(`${STUB}/ipfs/${deploy.receipt.siteCid}/env.txt`)).text();
      for (const secret of [SECRET_KEY, PINATA_JWT, "session-secret-e2e", "client-secret", WEBHOOK_SECRET]) expect(env).not.toContain(secret);
      expect(env).not.toMatch(/PUBLISHER_PRIVATE_KEY|PINATA_JWT|SESSION_SECRET|DATABASE_URL/);
      const logs = await logsOf(deploy.id);
      expect(logs).not.toContain(SECRET_KEY);
    });
    it("rejects a build that leaves a symlink", async () => {
      const { deploy } = await deployRepo("linky", {
        "package.json": JSON.stringify({ scripts: { build: "mkdir -p dist && cp index.html dist/ && ln -s /etc/hosts dist/leak" } }),
        "index.html": "<p>x</p>",
      }, 2002);
      expect(deploy.status).toBe("failed");
      expect(deploy.error).toMatch(/symlink/);
    });
    it("rejects output with secrets and no index.html", async () => {
      const a = await deployRepo("envfile", { "package.json": JSON.stringify({ scripts: { build: "mkdir -p dist && cp index.html dist/ && echo x > dist/.env" } }), "index.html": "<p>x</p>" }, 2003);
      expect(a.deploy.error).toMatch(/refusing/);
      const b = await deployRepo("noindex", { "package.json": JSON.stringify({ scripts: { build: "mkdir -p dist && echo hi > dist/a.txt" } }) }, 2004);
      expect(b.deploy.error).toMatch(/index\.html/);
    });
    it("a failing build fails the deploy with its logs", async () => {
      const { deploy } = await deployRepo("broken", { "package.json": JSON.stringify({ scripts: { build: "echo boom-output && exit 3" } }) }, 2005);
      expect(deploy.status).toBe("failed");
      expect(await logsOf(deploy.id)).toContain("boom-output");
    });
    it("builds from a subfolder with an output setting", async () => {
      const { deploy } = await deployRepo("mono", {
        "apps/web/package.json": JSON.stringify({ scripts: { build: "mkdir -p site && cp index.html site/" } }),
        "apps/web/index.html": "<p>mono</p>",
      }, 2006, { subfolder: "apps/web", outputDir: "site" });
      expect(deploy.status).toBe("live");
      expect(await (await fetch(`${STUB}/ipfs/${deploy.receipt.siteCid}/index.html`)).text()).toBe("<p>mono</p>");
    });
    it("builds a real Vite app with a lockfile", async () => {
      const dir = await makeRepo("vite-app", {
        "package.json": JSON.stringify({ name: "v", private: true, scripts: { build: "vite build" }, devDependencies: { vite: "^7" } }),
        "index.html": '<!doctype html><script type="module" src="/main.js"></script>',
        "main.js": "console.log('vite')",
        "vite.config.js": 'export default { base: "./" }',
      }, 2007);
      await run("npm", ["install", "--package-lock-only", "--no-audit"], { cwd: dir, env: { PATH: process.env.PATH, HOME: tmp } });
      await commit(dir, {});
      const { json } = await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/vite-app", deploy: true } });
      const d = await waitDeploy(json.deploy.id);
      expect(d.error).toBeNull();
      expect(d.status).toBe("live");
      const logs = await logsOf(d.id);
      expect(logs).toContain("Framework: vite");
      expect(logs).toContain("Package manager: npm");
      const html = await (await fetch(`${STUB}/ipfs/${d.receipt.siteCid}/index.html`)).text();
      expect(html).toMatch(/\.\/assets\/.*\.js/);
    }, 290_000);
    it("builds a real Next.js static export, and explains when it can't", async () => {
      const next = {
        "package.json": JSON.stringify({ name: "n", private: true, scripts: { build: "next build" }, dependencies: { next: "^15", react: "^19", "react-dom": "^19" } }),
        "app/layout.js": "export default function L({children}){return <html><body>{children}</body></html>}",
        "app/page.js": "export default function P(){return <p>next</p>}",
      };
      const good = await deployRepo("next-good", { ...next, "next.config.js": 'module.exports = { output: "export" }' }, 2008);
      expect(good.deploy.error).toBeNull();
      expect(good.deploy.status).toBe("live");
      expect(await logsOf(good.deploy.id)).toContain("Framework: next");
      const bad = await deployRepo("next-bad", next, 2009);
      expect(bad.deploy.status).toBe("failed");
      expect(bad.deploy.error).toMatch(/output: "export"/);
    }, 290_000);
    it("a private repo needs the user's access and uses an App token", async () => {
      await makeRepo("secret", SITE, 2010, true);
      expect((await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/secret" } }, "")).status).toBe(401);
      const { json, status } = await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/secret", deploy: true } });
      expect(status).toBe(201);
      const d = await waitDeploy(json.deploy.id);
      expect(d.status).toBe("live");
      expect(stubs.calls).toContain("POST /app/installations/7/access_tokens");
      expect(await logsOf(d.id)).not.toContain("ghs_shortlived");
    });
    it("publishes real IPNS through Kubo when it's configured, reusing the key", async () => {
      process.env.KUBO_API_URL = STUB;
      try {
        await makeRepo("ipns-site", SITE, 2011);
        const { json } = await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/ipns-site", deploy: true } });
        const d = await waitDeploy(json.deploy.id);
        expect(d.status).toBe("live");
        expect(d.receipt.ipns).toMatch(/^k51/);
        expect(stubs.ipnsPublished.at(-1)).toBe(`ensure-${json.project.id}->/ipfs/${d.receipt.siteCid}`);
        await commit(join(tmp, "gh/acme/ipns-site.git"), { "index.html": "<p>v2</p>" });
        const again = await waitDeploy((await call("/deploys", { method: "POST", body: { projectId: json.project.id } })).json.deploy.id);
        expect(again.receipt.ipns).toBe(d.receipt.ipns);
      } finally {
        delete process.env.KUBO_API_URL;
      }
    });
    it("rejects repos the user can't see, and non-GitHub URLs", async () => {
      expect((await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/none" } })).status).toBe(403);
      expect((await call("/projects", { method: "POST", body: { repoUrl: "https://evil.example/acme/plain" } })).status).toBeGreaterThanOrEqual(400);
    });
    it("runs several deploys at once without nonce clashes", async () => {
      const made = await Promise.all(["c1", "c2", "c3"].map(async (n, i) => {
        await makeRepo(n, SITE, 3000 + i);
        return (await call("/projects", { method: "POST", body: { repoUrl: `https://github.com/acme/${n}`, deploy: true } })).json.deploy.id;
      }));
      const done = await Promise.all(made.map((id) => waitDeploy(id)));
      expect(done.map((d) => d.status)).toEqual(["live", "live", "live"]);
    });
  });

  describe("custom name", () => {
    const prove = async (name: string, account: typeof owner) => {
      const { json } = await call("/names/custom/challenge", { method: "POST", body: { name, wallet: account.address } });
      const signature = await account.signMessage({ message: json.message });
      return call("/names/custom/verify", { method: "POST", body: { nonce: json.nonce, signature } });
    };

    it("refuses a project before ownership is proved", async () => {
      expect((await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/plain", name: PROJECT } })).status).toBe(403);
    });
    it("a wallet that doesn't own the name can't prove it", async () => {
      expect((await prove(PROJECT, stranger)).status).toBe(403);
    });
    it("a wrong signature is refused", async () => {
      const { json } = await call("/names/custom/challenge", { method: "POST", body: { name: PROJECT, wallet: owner.address } });
      const signature = await stranger.signMessage({ message: json.message });
      expect((await call("/names/custom/verify", { method: "POST", body: { nonce: json.nonce, signature } })).status).toBe(401);
    });
    it("the owner proves it", async () => {
      expect((await prove(PROJECT, owner)).status).toBe(200);
    });
    it("explains when a name isn't set up", async () => {
      expect((await prove(UNSET, owner)).status).toBe(200);
      const r = await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/plain", name: UNSET } });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/setup-ens project/);
    });
    it("deploys to preview only and leaves production alone", async () => {
      protectedDir = await makeRepo("protected", SITE, 4001);
      const { status, json } = await call("/projects", { method: "POST", body: { repoUrl: "https://github.com/acme/protected", name: PROJECT, deploy: true } });
      expect(status).toBe(201);
      expect(json.project.previewName).toBe(custom.previewName);
      const d = await waitDeploy(json.deploy.id);
      expect(d.error).toBeNull();
      expect(d.status).toBe("preview");
      expect(d.receipt.prodWriteBlocked).toBe(true);
      expect(d.receipt.name).toBe(custom.previewName);
      expect((await readContenthash(client, custom.previewName)).contenthash).toBe(d.receipt.contenthash);
      const prod = await readContenthash(client, custom.prodName).catch(() => ({ contenthash: "0x" }));
      expect(prod.contenthash).toBe("0x");
      custom.projectId = json.project.id;
    });
    it("this server can't roll back or configure a protected name", async () => {
      expect((await call(`/projects/${custom.projectId}/rollback`, { method: "POST", body: { deployId: custom.projectId } })).status).toBe(409);
      expect((await call(`/projects/${custom.projectId}/records`, { method: "POST", body: { key: "a", value: "b" } })).status).toBe(409);
    });
    it("fails loudly if the publisher ever gains production rights", async () => {
      await signer(owner).send({ address: custom.prodResolver, abi: resolverAbi, functionName: "grantRootRoles", args: [RESOLVER_ROLES.SET_CONTENTHASH | RESOLVER_ROLES.SET_TEXT, publisher.address] });
      const { json } = await call("/deploys", { method: "POST", body: { projectId: custom.projectId } });
      const d = await waitDeploy(json.deploy.id);
      expect(d.status).toBe("failed");
      expect(d.error).toMatch(/can write production/);
      await signer(owner).send({ address: custom.prodResolver, abi: resolverAbi, functionName: "revokeRootRoles", args: [RESOLVER_ROLES.SET_CONTENTHASH | RESOLVER_ROLES.SET_TEXT, publisher.address] });
    });
  });

  describe("isolation and restarts", () => {
    it("one user can't see another's projects or deploys", async () => {
      const { sql } = await import("../src/db");
      const [u] = await sql`INSERT INTO users (provider, provider_id, login) VALUES ('google', '9', 'bob') RETURNING id`;
      const { createSession } = await import("../src/auth");
      const bob = await createSession(u.id, "web");
      expect((await call(`/projects/${quick.id}`, {}, bob)).status).toBe(404);
      expect((await call(`/deploys/${firstQuickDeploy.id}`, {}, bob)).status).toBe(404);
      expect((await call(`/deploys/${firstQuickDeploy.id}/events`, {}, bob)).status).toBe(404);
      expect((await call("/deploys", { method: "POST", body: { projectId: quick.id } }, bob)).status).toBe(404);
      expect((await call(`/projects/${quick.id}/rollback`, { method: "POST", body: { deployId: firstQuickDeploy.id } }, bob)).status).toBe(404);
    });
    it("a restart marks interrupted deploys failed", async () => {
      const { sql } = await import("../src/db");
      const [d] = await sql`INSERT INTO deploys (project_id, status) VALUES (${quick.id}, 'running') RETURNING id`;
      const { startWorker } = await import("../src/deploys");
      (await startWorker(1, 60_000))();
      const [row] = await sql`SELECT status, error FROM deploys WHERE id = ${d.id}`;
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/restarted/);
    });
  });

  describe("CLI", () => {
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(join(tmp, "cli-")); });

    it("init connects a repo", async () => {
      await makeRepo("cli-site", SITE, 5001);
      const { stdout } = await cli(dir, "init", "--repo", "https://github.com/acme/cli-site");
      expect(stdout).toContain("Connected");
      expect(JSON.parse(readFileSync(join(dir, "ensure.json"), "utf8")).projectId).toBeTruthy();
    });
    it("push streams logs and prints a receipt", async () => {
      const { stdout } = await cli(dir, "push");
      expect(stdout).toContain("Site CID");
      expect(stdout).toContain("live");
      expect(stdout).toContain('"manifestCid"');
    });
    it("status reads the chain", async () => {
      const { stdout } = await cli(dir, "status");
      expect(stdout).toMatch(/CID:\s+baf/);
      expect(stdout).toContain("Recent deploys");
    });
    it("env set and get use ENS text records", async () => {
      await cli(dir, "env", "set", "deploy.env", "production");
      expect((await cli(dir, "env", "get", "deploy.env")).stdout.trim()).toBe("production");
    });
    it("rollback re-points the name", async () => {
      await commit(join(tmp, "gh/acme/cli-site.git"), { "index.html": "<p>new</p>" });
      await cli(dir, "push");
      const id = JSON.parse(readFileSync(join(dir, "ensure.json"), "utf8")).projectId;
      const { deploys } = (await call(`/projects/${id}/deploys`)).json;
      const { stdout } = await cli(dir, "rollback", deploys[deploys.length - 1].id);
      expect(stdout).toContain("now serves");
      expect(stdout).toContain(deploys[deploys.length - 1].receipt.siteCid);
    });
    it("publish works with your own keys and no server", async () => {
      const out = mkdtempSync(join(tmp, "out-"));
      writeAll(out, SITE);
      const name = custom.previewName;
      const res = await run(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "cli/src/index.ts"), "publish", out, "--name", name, "--repo", "https://github.com/acme/x", "--commit", "b".repeat(40)], {
        cwd: dir, env: { PATH: process.env.PATH, HOME: tmp, SEPOLIA_RPC_URL: RPC, PUBLISHER_PRIVATE_KEY: SECRET_KEY, PINATA_JWT, PINATA_API_URL: STUB, PINATA_UPLOADS_URL: STUB, IPFS_GATEWAYS: STUB, IPFS_RETRY_MS: "20" },
      });
      expect(res.stdout).toContain("Wrote receipt.json");
      const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
      expect((await readContenthash(client, name)).contenthash).toBe(receipt.contenthash);
    });
  });

  describe("server process", () => {
    it("pnpm server refuses to start without config", async () => {
      await expect(run(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "server/src/index.ts")], { cwd: tmp, env: { PATH: process.env.PATH } })).rejects.toThrow(/Missing env/);
    });
    it("the real entry point boots, migrates and serves", async () => {
      // Run node directly: killing the tsx wrapper would leave its child server running.
      const child = spawn(process.execPath, ["--import", join(ROOT, "node_modules/tsx/dist/esm/index.mjs"), join(ROOT, "server/src/index.ts")], { cwd: tmp, env: { ...process.env, PORT: "58201" }, stdio: "ignore" });
      procs.push(child);
      await waitFor(async () => (await fetch("http://127.0.0.1:58201/health")).ok, "server to boot", 30_000);
      expect(await (await fetch("http://127.0.0.1:58201/health")).json()).toEqual({ ok: true });
      expect((await fetch("http://127.0.0.1:58201/projects")).status).toBe(401);
      child.kill("SIGKILL");
    });
  });

  describe("no secrets stored or leaked", () => {
    it("no log line holds a secret", async () => {
      const { sql } = await import("../src/db");
      const rows = await sql`SELECT line FROM deploy_logs`;
      const all = rows.map((r) => r.line).join("\n");
      expect(rows.length).toBeGreaterThan(20);
      for (const s of [SECRET_KEY, PINATA_JWT, "session-secret-e2e", "ghs_shortlived", "user-token-1"]) expect(all).not.toContain(s);
    });
  });
});
