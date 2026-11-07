# ENSure build spec

How to build everything in [ARCHITECTURE.md](./ARCHITECTURE.md), one component at a time.

| Tag | Meaning |
| --- | --- |
| `[SOURCE]` | Read in `ensdomains/contracts-v2` at `07e55a056f5b6a9c90119f501bdd05714e67dddd`, the commit the ENS docs give for Sepolia |
| `[DOCS]` | Official ENS or Pinata docs, read 2026-11-06 |
| `[CHAIN]` | Checked on Sepolia, 2026-11-06 |
| `[DESIGN]` | A choice made here |
| `[TEST]` | Unconfirmed. Must be settled by a live run |

**Built and tested:** C1 to C10, C17 to C20, and the contracts for C18 and C21. **Not built:** every web page (C11, C14 to C16, C22), the verifier (C13), C23 and C24. The release controller compiles but has no tests. Code samples below are the design: where they differ from the code, the code wins.

---

## 1. Decisions

**1. One repo, one API, one language.** The base deploy product and Lifeboat live together. Everything except contracts is TypeScript.

**2. `preview` and `prod` are ERC-1155 tokens.** They're registered to the owner, with role bitmaps. A reserved entry has no owner, no token and no per-name roles, and `setResolver` checks token roles. `[SOURCE]`

**3. Pinata over plain HTTP.** The site goes to `pinFileToIPFS`, the route Pinata's docs give for folders. The manifest goes to `/v3/files`. See [C8](#c8-pin).

**4. The server never holds a role on a `prod` resolver.** A server compromise can't change a protected production site.

**5. Builds get no secrets.** Dependency scripts can't steal keys that aren't there.

**6. Verify never calls the server,** and isn't hosted on the site it checks. It has a CLI too.

**7. The demo tampers with a direct contenthash write, not a pointer change.** The controller checks the pointer before every write, so `recover` reverts while the pointer is wrong, and only the owner can repair it.

**Limits to state openly:**
- Revoking the publisher doesn't protect production, because it never had production rights. The separate resolver is what contains a server compromise.
- Recovery doesn't survive an owner compromise. The owner can revoke the controller or repoint `prod`.
- `recover` can re-select any approved release, including one later found to be bad.
- File hashes don't cover code a page loads from elsewhere. Verify warns about this.
- Quick names have no approval or recovery.

---

## 2. ENSv2: tokens and roles

Network: Sepolia. Mainnet isn't an option yet: *"Until the launch completes, resolution and registrations on Mainnet continue through the ENSv1 contracts."* `[DOCS]`

### Standards used

| Standard | Where | What you do with it |
| --- | --- | --- |
| ERC-1155 | `PermissionedRegistry is ERC1155Singleton` `[SOURCE]` | Parent, `preview` and `prod` are tokens. Each ID has one owner |
| ENSv2 EAC | `EnhancedAccessControl` on registries and resolvers `[SOURCE]` | All permissions: bitmaps per resource |
| ERC-165 | Resolver and registry `supportsInterface` `[SOURCE]` | Sanity check in setup |
| UUPS proxy | Resolver and registry instances via VerifiableFactory `[DOCS]` | One proxy per resolver, upgrade gated by `ROLE_UPGRADE` |
| ENSIP-7 | Contenthash | `0xe301` + CID bytes |

### Token rules `[SOURCE]` `[DOCS]`

- **Token IDs change** on role changes and re-registration (`TokenRegenerated`). Store the **labelhash**, and pass it as `anyId`.
- Regeneration mints a new ID to the owner, so the owner must accept ERC-1155. A Safe's default fallback handler should. `[TEST]`
- Roles move with the token on transfer.
- Transfer requires `ROLE_CAN_TRANSFER_ADMIN`, or it reverts with `TransferDisallowed`. **Leave this bit out of `preview` and `prod`**, so they can't be moved. `[DESIGN]`
- `getResolver` returns `address(0)` once a label expires. Use long expiries.

### Roles `[SOURCE]`

A role is a nybble in a `uint256` bitmap. Its admin is `role << 128`. You need the admin role to grant or revoke the role. Up to 15 accounts per role per resource.

| Registry role | Value | Scope |
| --- | --- | --- |
| `ROLE_REGISTRAR` | `1 << 0` | root |
| `ROLE_SET_PARENT` | `1 << 8` | root |
| `ROLE_UNREGISTER` | `1 << 12` | root or name |
| `ROLE_RENEW` | `1 << 16` | root or name |
| `ROLE_SET_SUBREGISTRY` | `1 << 20` | root or name |
| `ROLE_SET_RESOLVER` | `1 << 24` | root or name |
| `ROLE_CAN_TRANSFER_ADMIN` | `(1 << 28) << 128` | name |
| `ROLE_UPGRADE` | `1 << 124` | root |

| Resolver role | Value | Scope |
| --- | --- | --- |
| `ROLE_SET_TEXT` | `1 << 4` | root or text key |
| `ROLE_SET_CONTENTHASH` | `1 << 8` | root only |
| `ROLE_LINK` | `1 << 28` | root |
| `ROLE_UPGRADE` | `1 << 124` | root |

Resolver text resource: `uint256(keccak256(bytes(key)))`. `[SOURCE]`

### Who holds what

| Holder | Contract | Scope | Roles |
| --- | --- | --- | --- |
| Owner | ETHRegistry | parent token | `SET_SUBREGISTRY`, `SET_RESOLVER`, their admins, `CAN_TRANSFER_ADMIN` (from registration) `[SOURCE]` |
| Owner | Child registry | root | `REGISTRAR`, `SET_PARENT`, `UPGRADE`, and each admin |
| Owner | Child registry | `preview`, `prod` tokens | `SET_RESOLVER`, `RENEW`, and each admin |
| Owner | Both resolvers | root | `SET_CONTENTHASH`, `SET_TEXT`, `LINK`, `UPGRADE`, and each admin |
| publisher key | Preview resolver | root | `SET_CONTENTHASH` |
| publisher key | Preview resolver | key `ensure.manifest` | `SET_TEXT` |
| Controller | Prod resolver | root | `SET_CONTENTHASH` |
| Controller | Prod resolver | keys `ensure.manifest`, `ensure.release` | `SET_TEXT` |
| Recovery | none | | Authority comes only from the controller's `msg.sender` check |
| Deployer | none | | Sends setup transactions, keeps nothing |

The owner keeps `SET_CONTENTHASH` on prod so it can repair records. That's also how the demo tamper works.

### Role calls `[SOURCE]`

~~~solidity
// Resolver. Generic grantRoles reverts with EACCannotGrantRoles.
grantRootRoles(uint256 roleBitmap, address account)
revokeRootRoles(uint256 roleBitmap, address account)
grantSetterRoles(bytes setter, address account)        // setter = encoded setText(name, key, "")
revokeRoles(uint256 resource, uint256 roleBitmap, address account)

// Reads
hasRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)  // also checks root
hasRootRoles(uint256 roleBitmap, address account) returns (bool)
roles(uint256 resource, address account) returns (uint256)
getAssigneeCount(uint256 resource, uint256 roleBitmap) returns (uint256 counts, uint256 mask)
event EACRolesChanged(resource, account, oldRoleBitmap, newRoleBitmap)
~~~

Don't revoke a role *and* its admin in the demo. That's permanent. `[DOCS]`

### Contract calls `[SOURCE]`

~~~solidity
// Registry
register(string label, address owner, IRegistry registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)
setSubregistry(uint256 anyId, IRegistry registry)
setResolver(uint256 anyId, address resolver)
setParent(IRegistry parent, string label)
renew(uint256 anyId, uint64 newExpiry)
getResolver(string label) view returns (address)

// Resolver. Names are DNS-encoded bytes, not namehashes.
setContenthash(bytes name, bytes hash)
setText(bytes name, string key, string value)
multicall(bytes[] calls) returns (bytes[])      // atomic; delegatecalls itself, so msg.sender stays the caller
initialize(Grant[] grants, bytes[] calls)       // Grant = (address account, uint256 roleBitmap), root scope

// Factory
deployProxy(address implementation, uint256 salt, bytes data) returns (address)
event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)

// Reads
UniversalResolver.resolve(bytes name, bytes data) view returns (bytes, address)
UniversalHelper.findParentRegistry(bytes name) view returns (IRegistry)

// ETHRegistrar
commit(bytes32 commitment)
makeCommitment(string label, address owner, bytes32 secret, IRegistry subregistry, address resolver, uint64 duration, bytes32 referrer)
register(string label, address owner, bytes32 secret, IRegistry subregistry, address resolver, uint64 duration, IERC20 paymentToken, bytes32 referrer)
getRegisterPrice(string label, uint64 duration, IERC20 paymentToken)
~~~

### Sepolia addresses

All returned contract code on 2026-11-06. `[CHAIN]`

| Contract | Address |
| --- | --- |
| Universal Resolver proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |
| UniversalHelper | `0xd453e5bdb62cc3bea84341b1e306319c8ffd7dfe` |
| ETHRegistry | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| ETHRegistrar | `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3` |
| VerifiableFactory | `0xda70306c98e97ece36f997a21368e53298572991` |
| PermissionedResolverImpl | `0x115eb53f0c60696633855f90b138178fb40b2b2c` |
| UserRegistryImpl | `0x9bd8a88719068d09ecee662f36c0e3856708366a` |

Test payment tokens `[DOCS]`: MockUSDC `0x240b0316df57887dbbe58b586508b19e633a14aa`, MockDAI `0xf6fac8a58a0be13b9197f27c41b73162fe32572b`.

ABIs: `contracts/deployments/sepolia/<Name>.json` in `ensdomains/contracts-v2`. Keep only the fragments you call, in `core/src/ens.ts`.

---

## 3. Project structure

~~~text
ENSure/
├── contracts/
│   ├── foundry.toml
│   ├── src/              ENSureReleaseController, DeployRegistry, AccessController, EnsOwned
│   ├── test/
│   └── script/Deploy.s.sol
├── core/src/             shared by server, CLI and web
│   ├── manifest.ts       canonical form, hashes
│   ├── ens.ts            ABIs, roles, contenthash, reads
│   ├── setup.ts          transaction list for name setup
│   ├── pipeline.ts       validate, pin, publish (Node only)
│   ├── verify.ts         the verifier (C13)
│   └── api.ts            API and event types
├── server/
│   ├── src/              index, db, auth, github, projects, names, deploys, builder, ipns, bot
│   ├── migrations/
│   └── Dockerfile.builder
├── cli/src/              init, push, publish, status, rollback, env, verify
├── web/                  landing, dashboard, deploy, Verify, Owner, Recover (not built yet)
├── site/                 the demo site that gets deployed
├── scripts/setup-ens.ts  one-time platform and demo-project setup
├── deployments/sepolia.json
├── docs/
├── .github/workflows/
├── docker-compose.yml    local Postgres
├── .env.example
├── package.json
└── pnpm-workspace.yaml
~~~

One API, one database, one shared library. Tools for each are in [TECH_AND_DEMO.md](./TECH_AND_DEMO.md).

**Setup:**
~~~bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
docker compose up -d
pnpm install
~~~

Check `https://docs.ens.domains/web/ensv2-readiness` for the viem version before installing. That page hasn't been read yet.

`site/vite.config.ts` sets `base: "./"`, so the demo site works under any gateway path.

**Accounts, all separate:** Owner (Safe, or EOA on stage), Recovery, Server publisher (new EOA), Deployer (local EOA).

---

## 4. Build plan

One component at a time. Finish and test each before starting the next.

### Foundation

| # | Component | What it does | Code | Needs | Done when |
| --- | --- | --- | --- | --- | --- |
| C1 | [Manifest](#c1-manifest) | Build output → canonical manifest and digests | `core/src/manifest.ts` | none | Unit tests pass |
| C2 | [ENS library](#c2-ens-library) | Encoding, role constants, ABIs, record reads | `core/src/ens.ts` | none | ENSIP-7 vector and role values match |
| C3 | [ENS setup](#c3-ens-setup) | Names, resolvers and roles on Sepolia | `core/src/setup.ts`, `scripts/setup-ens.ts` | C2 | Gate table passes |

### Base: deploy to ENS

| # | Component | What it does | Code | Needs | Done when |
| --- | --- | --- | --- | --- | --- |
| C4 | [Database and API](#c4-database-and-api) | Postgres, migrations, API skeleton, shared types | `server/`, `core/src/api.ts` | none | Health route and migrations run |
| C5 | [Login](#c5-login) | GitHub, Google, sessions, CLI tokens | `server/src/auth.ts` | C4 | Login works; cookie is HTTP-only |
| C6 | [GitHub](#c6-github) | Repos, branches, connect, push webhook | `server/src/github.ts` | C5 | Signed push queues a deploy of that SHA |
| C7 | [Builder](#c7-builder) | Clone and build in Docker, no secrets | `server/src/builder.ts` | C4 | Next, Vite, CRA and plain fixtures build; no secret visible inside |
| C8 | [Pin](#c8-pin) | Validate, hash, pin site and manifest, fetch back | `core/src/pipeline.ts` | C1 | Fixture fetched by CID, paths intact |
| C9 | [Deploy pipeline](#c9-deploy-pipeline) | Queue, stages, live logs, write ENS, receipt | `server/src/deploys.ts`, `core/src/pipeline.ts` | C2, C3, C7, C8 | One click: repo → name → site opens |
| C10 | [Names](#c10-names) | Quick names, custom-name proof, project setup | `server/src/names.ts` | C3, C9 | Both name modes deploy |
| C11 | [Dashboard](#c11-dashboard) | Login, dashboard, connect, deploy, project pages | `web/` | C5, C6, C9, C10 | Full deploy from the browser |

### Lifeboat

| # | Component | What it does | Code | Needs | Done when |
| --- | --- | --- | --- | --- | --- |
| C12 | [Controller](#c12-controller) | Promote, rollback, recover | `contracts/` | C3 | Tests and fork test pass; deployed; roles checked |
| C13 | [Verifier](#c13-verifier) | Checks → MATCH / MISMATCH / UNAVAILABLE / UNPROTECTED | `core/src/verify.ts` | C1, C2, C12 | Every check row tested |
| C14 | [Verify page](#c14-verify-page) | Verifier in the browser | `web/` at `/verify` | C13 | Fresh browser shows every state |
| C15 | [Owner page](#c15-owner-page) | Review candidate, Promote, Rollback, revoke publisher | `web/` | C11, C12 | Promote and rollback work from the UI |
| C16 | [Recover page](#c16-recover-page) | Restore an approved release with a reason | `web/` | C12 | Recover from the UI; Verify returns MATCH |

### Rest of the base features

| # | Component | What it does | Code | Needs | Done when |
| --- | --- | --- | --- | --- | --- |
| C17 | [CLI](#c17-cli) | `init`, `push`, `publish`, `status`, `rollback`, `env`, `verify` | `cli/` | C9, C12, C13 | Each command works against live services |
| C18 | [Deploy log and config](#c18-deploy-log-and-config) | On-chain log, ENS text records as config | `contracts/src/DeployRegistry.sol` | C9 | Only the name owner can authorize; config round-trips |
| C19 | [Telegram bot](#c19-telegram-bot) | Guided and paste-a-URL deploys, AI chat | `server/src/bot.ts` | C9 | Linked user deploys from chat |
| C20 | [IPNS](#c20-ipns) | Real IPNS publishing for previews | `core/src/pipeline.ts` | C9 | Name resolves to latest CID on a gateway |
| C21 | [Access control](#c21-access-control) | Public, token, allowlist, DAO, pause | `contracts/src/AccessController.sol` | C2 | Tests pass; demo page gates |
| C22 | [Landing page](#c22-landing-page) | Marketing page | `web/` | none | Live on the static host |
| C23 | [CI](#c23-ci) | Repo tests, secret scan, deploy-from-Actions template | `.github/workflows/` | C17 | PRs tested; template publishes preview |

### Finish

| # | Component | What it does | Code | Needs | Done when |
| --- | --- | --- | --- | --- | --- |
| C24 | [Demo and submit](#c24-demo-and-submit) | Full demo, README, public repo | `docs/` | all | Script runs live; checklist done |

**Order notes**
- C1 and C2 are pure code with no network. Start here.
- C3 is the first live step and the most likely to change assumptions. Don't build C9 or deploy C12 until its gate passes.
- C8's live test settles the open Pinata questions.
- **C1 to C16 are the complete demo.** C17 to C23 finish parity with the reference system. If time runs out, cut from the bottom in this order: C21, C20, C19. Say what was cut. Don't ship a fake.
- C12's unit tests need only mocks, so they can run any time.

---

## C1. Manifest

**Exports:** `hashFiles`, `buildManifest`, `canonicalize`, `manifestBytes`, `manifestDigest`, `commitDigest`, `parseManifest` (bytes → manifest, rejects non-canonical input).

Browser-safe: no `fs`.

**Canonical form:**
- Keys sorted by code unit, recursively. No whitespace. UTF-8, no trailing newline.
- Numbers: non-negative safe integers only.
- `files` sorted by `path`. No duplicates.
- Paths: relative, `/` separators. No `.`, `..`, leading `/` or backslash. NFC only.
- `sha256`: 64 lowercase hex. `commitSha`: 40 lowercase hex.
- MIME from a fixed extension table, never the OS.

~~~ts
export function canonicalize(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("bad number");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  throw new Error("bad value");
}
export const manifestBytes = (m: Manifest) => new TextEncoder().encode(canonicalize(m));
export const manifestDigest = (b: Uint8Array) => keccak256(b);
export const commitDigest = (sha: string) => keccak256(toBytes(sha));
~~~

"Repeatable digest" means the same inputs give the same bytes. The manifest includes the run URL, so a re-run of CI gives a new digest. That's correct.

**Tests:** key order, repeat runs, each bad path, unicode, floats.

---

## C2. ENS library

**Exports:** `dnsEncode`, `encodeContenthash`, `decodeContenthash`, role constants, ABI fragments, `readRecords(client, name)` → `{contenthash, manifestCid, releaseId, resolver}`.

~~~ts
export const dnsEncode = (name: string) => toHex(packetToBytes(normalize(name)));   // viem/ens

export const encodeContenthash = (cid: string): Hex =>
  concat(["0xe301", toHex(CID.parse(cid).toV1().bytes)]);

export function decodeContenthash(hex: Hex): CID {
  if (!hex.toLowerCase().startsWith("0xe301")) throw new Error("not ipfs");
  return CID.decode(hexToBytes(`0x${hex.slice(6)}`));
}
~~~

Compare CIDs as v1 bytes, never as strings.

**First unit test, ENSIP-7 vector** `[DOCS]`: `ipfs://QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4` ↔ `0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f`.

**Read records** through the Universal Resolver:
~~~ts
const data = encodeFunctionData({ abi: resolverAbi, functionName: "contenthash", args: [namehash(name)] });
const [result, resolver] = await client.readContract({
  address: UNIVERSAL_RESOLVER, abi: urAbi, functionName: "resolve", args: [dnsEncode(name), data],
});
~~~
Pass `multicall(bytes[])` as `data` to read all three records in one call. `[DOCS]`

---

## C3. ENS setup

Goal: create names and prove permission isolation live.

Put the transaction list in `core/src/setup.ts`, so `scripts/setup-ens.ts` and the website's project wizard (C10) run the same steps. Run it first with an EOA owner on a throwaway name, then with the real owner.

`lifeboat.eth` is a placeholder.

**1. Register the parent to the owner.** Through the Sepolia ENS app, or `commit` → wait `MIN_COMMITMENT_AGE` → `register`, with `owner` set to the owner. Read the age and price from the contract.

**2. Deploy two resolvers** with `deployProxy(PermissionedResolverImpl, salt, initialize(grants, []))`:
~~~text
salt   = keccak256(abi.encode(keccak256("OwnedResolver"), owner, version))   // version 0 preview, 1 prod
grants = [(owner, SET_CONTENTHASH | SET_TEXT | LINK | UPGRADE + each admin)]
~~~
The salt must differ, so use a different `version` for each.

**3. Deploy the child registry** with `deployProxy(UserRegistryImpl, salt, initialize(grants))`:
~~~text
salt   = keccak256("UserRegistry", namehash, version)                        // [DOCS]; check encoding against the docs example
grants = [(owner, REGISTRAR | SET_PARENT | UPGRADE + each admin)]
~~~

**4. Attach it** (owner):
~~~text
ETHRegistry.setSubregistry(uint256(labelhash("lifeboat")), child)
child.setParent(ETHRegistry, "lifeboat")
~~~

**5. Register the tokens** (owner):
~~~text
bitmap = SET_RESOLVER | SET_RESOLVER_ADMIN | RENEW | RENEW_ADMIN    // no CAN_TRANSFER_ADMIN
child.register("preview", owner, address(0), previewResolver, bitmap, expiry)
child.register("prod",    owner, address(0), prodResolver,    bitmap, expiry)
~~~

**6. Grant the publisher preview rights** (owner):
~~~text
previewResolver.grantRootRoles(ROLE_SET_CONTENTHASH, publisher)
previewResolver.grantSetterRoles(encode setText(previewDns, "ensure.manifest", ""), publisher)
~~~

**7. Gate.** All must hold, with tx hashes saved:

| Caller | Call | Expected |
| --- | --- | --- |
| Publisher | preview `multicall([setContenthash, setText("ensure.manifest")])` | Succeeds |
| Anyone | Read preview through the Universal Resolver | Returns the values, and the `address` returned is the preview resolver `[TEST]` |
| Publisher | `prodResolver.setContenthash` | Reverts `EACUnauthorizedAccountRoles` |
| Publisher | `previewResolver.setText("ensure.release")` | Reverts |
| Publisher | `previewResolver.grantRootRoles` | Reverts `EACCannotGrantRoles` |
| Publisher | `child.setResolver` | Reverts |
| Owner | `child.setResolver(labelhash("prod"), x)`, then restore | Succeeds, and works by labelhash after the token ID changes |
| Owner | `safeTransferFrom` on the `prod` token | Reverts |

Write all addresses and the deployment block to `deployments/sepolia.json`.

**Platform setup, for quick names.** The same way, once, for `<platform>.eth`:
~~~text
Deploy a child registry and one shared resolver. Owner is the platform.
child.grantRootRoles(ROLE_REGISTRAR, publisher)
resolver.grantRootRoles(ROLE_SET_CONTENTHASH, publisher)
resolver.grantSetterRoles(encode setText(name, "ensure.manifest", ""), publisher)
~~~
A shared resolver means the publisher can write every quick name. That's fine, since the platform owns them and they make no approval claim.

---

## C4. Database and API

**Does:** one Node service with Postgres, and nothing else yet.

- `docker-compose.yml` runs Postgres locally. Plain SQL files in `server/migrations/`, tables in [ARCHITECTURE.md section 7](./ARCHITECTURE.md#7-data).
- Routes in [section 6](./ARCHITECTURE.md#6-api). Validate every body with `zod`.
- `core/src/api.ts` holds request, response and SSE event types, imported by server, web and CLI. This is what stops clients drifting from the API.
- Fail at startup if required env is missing.

---

## C5. Login

**Does:** login and sessions.

- **GitHub:** GitHub App user login. No `repo`-scope token kept anywhere readable.
- **Google:** OAuth. These users can deploy public repos only.
- **Sessions:** random token, stored hashed, HTTP-only `Secure` cookie. Never a token in a URL or `localStorage`.
- **CLI:** `POST /auth/cli-token` issues a revocable token, stored hashed. Telegram links through a one-time code.
- **OAuth `state`:** stored in Postgres with a 10-minute expiry.

**Test:** expired session rejected, wrong `state` rejected, no token in any redirect URL.

---

## C6. GitHub

**Does:** connects repos, and turns pushes into deploys.

- List repos and branches through App installation tokens, which are short-lived.
- `POST /projects` links repo, branch, subfolder and name. Save the immutable repo ID.
- **Webhook:** verify `X-Hub-Signature-256` against the raw body in constant time, before parsing. Ignore other branches. Queue a deploy with `payload.after`, the exact SHA. Answer 202.
- Ignore duplicate delivery IDs.

**Test:** bad signature rejected, other branch ignored, queued deploy holds the pushed SHA.

---

## C7. Builder

**Does:** turns a repo at a SHA into a folder of static files.

**Input:** `https://github.com/o/r`, optionally `/tree/branch/sub/folder`, or a connected project. GitHub only. Parse and validate before anything else.

**Steps:**
1. **Clone container:** token passed by env, never in args. Fetch the exact SHA. Container exits, token gone.
2. **Build container:** no secrets, no token. Detect the package manager from the lockfile and install with it frozen. Detect the framework from `package.json`. Run the build.
3. **Find output:** per-project setting, else by framework: `out` (Next), `dist` (Vite), `build` (CRA). Plain sites with no `package.json` publish the folder, excluding `.git`.

**Container limits:** `--cap-drop ALL`, `--security-opt no-new-privileges`, memory, CPU and PID limits, a build timeout, non-root user, named cache volumes per package manager. `Dockerfile.builder` pre-installs git and corepack.

**Don't rewrite the user's project.** If a Next app has no `output: "export"`, fail with a message saying so.

**Absolute asset paths** such as `/_next/...` break on path-style gateways, so open-site links use subdomain gateways: `https://<cid>.ipfs.dweb.link`.

**Test:** one fixture per framework, then one that prints `env` and confirms no secret appears, and one that tries to leave a symlink pointing outside the output.

---

## C8. Pin

**Does:** build output directory in; two CIDs and digests out. In `core/src/pipeline.ts`, used by the server and CLI.

1. Reject: empty output, no `index.html`, symlinks, paths outside the root, `.env*`, `*.pem`, `*.key`, `.git/`, `.npmrc`, content matching key patterns.
2. `hashFiles`, then pin the site → `siteCid`.
3. `buildManifest` with `siteCid`, then pin the manifest → `manifestCid`.
4. Fetch the manifest and `index.html` by CID and compare bytes. Retry with backoff. Fail the job if still different.

**Output:** `{siteCid, manifestCid, manifestDigest, commitDigest, contenthash}`.

**Site:** `POST https://api.pinata.cloud/pinning/pinFileToIPFS`, with one `file` part per file named `release/<path>`, and `pinataOptions: {"cidVersion":1}`. Pinata's docs say *"At this time folder uploads must go through /pinFileToIPFS."* `[DOCS]` The newer `fileArray` SDK call wasn't used, because its docs don't say whether it returns a root CID or keeps paths.

**Manifest:** `POST https://uploads.pinata.cloud/v3/files`, as a file with `network=public`.

**Fetch-back:** `<cid>/index.html` and the manifest, through public gateways, comparing bytes. If Pinata lays files out differently than expected, the deploy fails here instead of publishing a broken site. `[TEST]` This hasn't run against real Pinata yet.

**Rules** `[DOCS]`:

| Rule | Why |
| --- | --- |
| Always send `network=public` to `/v3/files` | The API defaults to private, which isn't retrievable from public gateways |
| Don't use `pinJSONToIPFS` for the manifest | Neither promises byte-exactness, and the digest depends on it |
| Never set an expiry, never unpin an approved release | *"Once the expiration time is reached, the file will be automatically deleted"*, and recovery needs old files |
| Keep CID version 1 | Contenthash needs it, and newer profiles add nothing here |
| Scoped key: `org:files:write` | The docs give no scope for legacy endpoints, and legacy-scoped keys don't carry over. Test the fallback with this key `[TEST]` |

**Gateways** `[DOCS]`:
- Dedicated gateways serve only your own pins by default.
- *"HTML files can be uploaded on any plan, but can only be retrieved through a Dedicated Gateway with a Custom Domain."*

So read back and verify through public gateways: `https://ipfs.io`, `https://dweb.link`. Add a custom-domain Pinata gateway if you have one. Allow retries, since new content takes time to spread. CORS isn't documented, so test in a browser. `[TEST]`

**Not used:**

| Feature | Why not |
| --- | --- |
| CAR uploads | Paid plans only, result arrives by webhook |
| Presigned URLs | For browser uploads. The server holds its own key |
| Groups | Nothing queries them |
| x402 pinning | Pays per pin. Not needed |
| Private IPFS | Enterprise, and visitors must be able to fetch |

Free plan limit: 60 API requests per minute.

---

## C9. Deploy pipeline

**Does:** the deploy itself: repo in, live site out. The `deploys` table is the queue (`FOR UPDATE SKIP LOCKED`), with a concurrency limit.

**Stages,** each logging over SSE and recorded in `deploys`:
1. Build (C7).
2. Validate, hash, pin (C8). `dryRun` stops here.
3. **Check the commit is still the latest on its branch** through the GitHub API. If not, end as superseded.
4. Write the name.
   - Quick: register if new, then `multicall([setContenthash, setText("ensure.manifest", cid)])` on the platform resolver. The site is live.
   - Protected: the same multicall on the **preview** resolver.
5. Read back through the Universal Resolver. Fail on any difference.
6. **Protected only:** simulate the publisher's production `setContenthash`. It must revert. A success fails the deploy.
7. Log the deploy (C18). Save the receipt: commit, repo ID, build log link, both CIDs, manifest digest, commit digest, contenthash, tx hashes, `prodWriteBlocked`.

**SSE events:** `log`, `stage`, `done`, `error`, one format from `core/src/api.ts`, with a 15-second heartbeat. Use `fetch` streaming in clients, since `EventSource` can't send auth headers.

**Sending transactions:** the worker has one publisher key, so one sender at a time, with nonce handled by viem.

**Restart safety:** the queue survives restarts, and a stage that died is marked failed.

A small race remains between stages 3 and 4. Mention it if asked.

**Test:** full run against a fixture repo on Sepolia. Kill the worker mid-build and confirm the deploy shows failed.

---

## C10. Names

**Does:** gets a name onto a project.

**Quick name:** generate `<adjective>-<noun>-<4 hex>`, check `getStatus` returns `AVAILABLE`, register it under the platform registry, owned by the platform.

**Custom name, proof of ownership:**
1. `POST /names/custom/challenge`: returns a message with name, wallet, nonce and expiry.
2. User signs it. Works for contract wallets through ERC-1271, using viem `verifyMessage`.
3. `POST /names/custom/verify`: check the signature, then read `UniversalHelper.findExactOwner(dnsName)`. It must equal the wallet.

**Project setup wizard:** runs the `core/src/setup.ts` steps from the user's wallet, shows each transaction, and resumes after a refresh by reading chain state. It grants the publisher preview rights, deploys the controller (C12), and writes `ensure.controller`.

**Never trust a claimed tx hash.** Read the state it should have produced.

**Done when:** one quick and one protected project both deploy.

---

## C11. Dashboard

**Does:** the logged-in site.

| Route | Content |
| --- | --- |
| `/login` | GitHub and Google |
| `/dashboard` | Projects, latest deploy, status |
| `/connect` | Repo → branch and folder → name → done |
| `/deploy` | Repo picker or URL, live log terminal, receipt |
| `/projects/:id` | Deploy history, current records, gateway links, IPNS, config, access policy |

Shows evidence on every deploy: commit, CIDs, tx hashes, and whether it's live or waiting for promotion.

**Done when:** a new user goes from login to an open site in the browser.

---

## C12. Controller

Code: [`contracts/src/ENSureReleaseController.sol`](../contracts/src/ENSureReleaseController.sol). Local interfaces match the ENS signatures, so the ENS repo isn't a dependency. A fork test proves they match.

- `rollback` and `recover` accept the current release, so re-asserting it repairs a direct write.
- `ensure.release` is lowercase `0x` hex. Verify compares it exactly.
- Promoting the same artifact twice reverts `ReleaseExists`. Use `rollback`.
- A contract can't read its own tx hash, so approval txs come from event logs. Page from the deployment block.
- `string` and `bytes` can't be `immutable`, so the label is a `constant` and the DNS name has no setter.

**Deploy:** from the wizard with viem `deployContract` and the compiled bytecode, or for the demo:
~~~bash
forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --broadcast --verify --interactive
~~~

**Then grant, from the owner:**
~~~text
prodResolver.grantRootRoles(ROLE_SET_CONTENTHASH, controller)
prodResolver.grantSetterRoles(encode setText(prodDns, "ensure.manifest", ""), controller)
prodResolver.grantSetterRoles(encode setText(prodDns, "ensure.release",  ""), controller)
~~~

**Then write the pointer, from the owner:**
~~~text
prodResolver.setText(prodDns, "ensure.controller", controllerAddress)
~~~
Verify uses it to find the controller. The controller has no role on this key, so only the owner can change it.

**Then check:** `roles(ROOT_RESOURCE, controller)` equals exactly `ROLE_SET_CONTENTHASH`, and the controller holds nothing on either registry or the preview resolver.

**Tests:**

| Test | Assert |
| --- | --- |
| `promote`, `rollback` by anyone but owner | `NotOwner` |
| `recover` by anyone but recovery | `NotRecoveryAuthority` |
| Empty arguments, empty reason | `EmptyValue` |
| Promote | Three records, current ID, stored fields, event |
| Same artifact twice | `ReleaseExists` |
| Second promote | `previousReleaseId` correct |
| Unknown ID on rollback or recover | `UnknownRelease` |
| Pointer changed | All three functions revert `ResolverMismatch` |
| Mock resolver fails third setter | Full revert |
| Recover to current after a direct write | Records restored |
| Bad constructor config | `InvalidConfig` |
| **Sepolia fork** | Real resolver and roles. Works with roles, reverts without |

---

## C13. Verifier

`core/src/verify.ts` takes `{name, fetchers}` and emits one result per check. Web and CLI share it.

**First, read `ensure.controller`.** If it's empty, the name is unprotected: run only checks 1, 8, 12 and 13 against the `ensure.manifest` record, and the result is at best **UNPROTECTED**, never green. A user can also pin a controller address, which then must match.

| # | Check | Expected | On failure |
| --- | --- | --- | --- |
| 1 | Read contenthash and both text records | Returned | UNAVAILABLE |
| 2 | Resolver returned by `resolve` | `controller.productionResolver()` | MISMATCH |
| 3 | `productionRegistry.getResolver("prod")` | Same resolver | MISMATCH |
| 4 | `UniversalHelper.findParentRegistry(name)` | `controller.productionRegistry()` | MISMATCH |
| 5 | `currentReleaseId` | Non-zero, equals `ensure.release` | MISMATCH |
| 6 | `getRelease(id).contenthash` | ENS contenthash, byte-equal | MISMATCH |
| 7 | `getRelease(id).manifestCid` | `ensure.manifest` | MISMATCH |
| 8 | Fetch manifest by CID | Retrieved | UNAVAILABLE |
| 9 | keccak256 of raw bytes | `manifestDigest` | MISMATCH |
| 10 | Bytes re-canonicalize to themselves | Equal | MISMATCH |
| 11 | keccak256 of `commitSha` | `commitDigest` | MISMATCH |
| 12 | Contenthash CID | `manifest.siteCid`, as v1 bytes | MISMATCH |
| 13 | Each file by `siteCid` + path | SHA-256 and size equal | Differs: MISMATCH. Can't fetch: UNAVAILABLE |
| 14 | `UniversalHelper.findExactOwner(name)` | `controller.ownerSafe()` | MISMATCH |
| 15 | `controller.projectNode()` | `namehash(name)` | MISMATCH |

**Result:**
~~~text
any MISMATCH          → MISMATCH (name each failure, show the last approved release)
else any unfinished   → UNAVAILABLE
else no controller    → UNPROTECTED
else                  → MATCH
~~~

Show expected and observed values, commit, run, both CIDs, approval tx, previous release, recovery events and reasons.

**Warnings beside the result, not states:**
- HTML loads external `script` or stylesheet URLs: *"This page loads code these checks don't cover."*
- Writer count isn't the expected one, using `getAssigneeCount`: 2 on root `SET_CONTENTHASH` (owner, controller), 1 on root `SET_TEXT`, `LINK` and `UPGRADE`, 1 on each text key: *"The set of accounts able to write this name has changed."* Each role's count is the nybble at that role's position in `counts`. `[TEST]`

**Fetching:** try gateways in order, with timeouts. Hash the raw `arrayBuffer`. Encode each path segment. Limit to about 6 concurrent fetches. If one gateway returns wrong bytes and another returns correct ones, report that gateway and continue.

**CLI exit codes:** `0` MATCH, `1` MISMATCH, `2` UNAVAILABLE, `3` UNPROTECTED.

**Tests, with injected fetchers:** one per row, RPC down, one gateway down, all gateways down, one changed byte, extra whitespace in the manifest, reordered keys.

Checks 14 and 15 stop a fake controller: pointing `ensure.controller` at one needs the owner's key, and a fake one fails these against the real registry.

---

## C14. Verify page

Web app: Static Vite and React with wagmi and viem. No backend. Use viem `fallback` across several RPCs, small batches, paged logs.

**Copy rule:** say "verified release", never "safe". Every result carries: *"This checks the release matches what the owner approved. It doesn't mean the code is safe."*

**Does:** at `/verify`, runs the verifier in the browser. Shows the check list, the result, a release timeline and the live role table. No wallet. Never served from a site it checks.

- Timeline: controller events plus `EACRolesChanged` from both resolvers.
- UNAVAILABLE demo: a marked test toggle that points at a dead RPC or gateway.

**Done when:** a fresh browser shows MATCH, MISMATCH after a direct write, UNAVAILABLE with the toggle, and UNPROTECTED on a quick name.

---

## C15. Owner page

**Does:** at `/projects/:id/owner`, shows a candidate's evidence, then Promote, Rollback and revoke publisher.

- Candidate: read the current preview records, fetch the manifest, compute digests in the browser. Don't take these from the server, since it's the party being checked.
- After Promote, re-read production and the controller. Show **Live** only when they agree.
- Safe owner: show calldata for Safe Transaction Builder, or connect via WalletConnect. Use a 1-of-2 Safe so one signer can execute live. Poll chain state, since a Safe executes later.

**Done when:** Promote and Rollback work on Sepolia from the UI, and Live appears only after read-back agrees.

---

## C16. Recover page

**Does:** at `/projects/:id/recover`, lists approved releases from controller events. The recovery authority picks one, enters a reason and calls `recover`. Other wallets see a disabled form.

**Done when:** `recover` from the UI emits an event with the reason, and Verify returns MATCH.

---

## C17. CLI

**Does:** every website deploy action from a terminal, built on `core/src/api.ts`.

| Command | Does |
| --- | --- |
| `ensure init` | Writes `ensure.json`: name, branch, folder |
| `ensure login` | Gets a CLI token |
| `ensure push` | Queues a deploy, streams logs, prints the receipt |
| `ensure publish` | Runs the pipeline locally or in CI with your own keys, no server |
| `ensure status [name]` | Records, current release, recent deploys, gateways |
| `ensure rollback` | Lists releases, sends the transaction from a local signer or prints Safe calldata |
| `ensure env set\|get\|list` | ENS text records |
| `ensure verify <name>` | The verifier. Needs no login. Comes with C13 |

The token comes from `ENSURE_TOKEN` or `~/.ensure/token`. Never a private key flag.

**Test:** each command against the live stack.

---

## C18. Deploy log and config

**Does:** a public deploy history and config in ENS, including previews, which the controller doesn't cover.

**`DeployRegistry`**, keyed by namehash:
~~~solidity
setPublisher(bytes dnsName, address publisher, bool allowed)   // requires findExactOwner(dnsName) == msg.sender
logDeploy(bytes32 node, bytes cid, string env, string meta)    // requires an allowed publisher
getDeployHistory(bytes32 node, uint256 offset, uint256 limit)  // newest first
~~~
Env is `production`, `staging` or `preview`. The log is a record of what was published, not a source of truth: Verify doesn't rely on it.

**Config:** `ensure env` and the project page set text records such as `deploy.framework` or `build.command`, from the owner's wallet. Protected names write through the owner, since the controller and publisher have no role on those keys.

**Tests:** non-owner can't set a publisher, unknown publisher can't log, pagination.

---

## C19. Telegram bot

**Does:** deploy from Telegram.

- Commands: `/start`, `/help`, `/deploy`, `/status`, `/cancel`, `/link`.
- **Must be linked to a user** through a one-time code, so a stranger can't spend your gas.
- Paste a GitHub URL for an automatic quick deploy. Batch logs into one edited message, every 2 seconds, to stay within rate limits.
- **AI:** LLM through OpenRouter, for chat help and turning a message into `{repoUrl, env, nameMode, name}`. Treat its output as untrusted: validate with `zod`, and fall back to a regex parser if it's unavailable or invalid.
- Bot disabled if its token isn't set.
- Protected names get preview only, same as everywhere.

**Test:** unlinked user refused, invalid LLM output falls back.

---

## C20. IPNS

**Does:** a stable, free-to-update pointer for previews and quick names.

- Generate one IPNS key per project, stored encrypted on the server.
- After each deploy, publish `ipns://<key>` → the new CID. Store the key in text record `ensure.ipns`.
- **Never for `prod`.** A protected production name always points at an immutable CID, because Verify depends on that.

Publishing goes through a Kubo node's API, set with `KUBO_API_URL`. Off by default, and a failure doesn't fail the deploy. `[TEST]` It's tested against a stub of Kubo's API, not a real node.

**Done when:** a gateway resolves the IPNS name to the latest CID.

---

## C21. Access control

**Does:** per-name access policy.

**`AccessController`**, keyed by namehash, with policy set only by `findExactOwner(dnsName)`:
~~~solidity
enum Policy { PUBLIC, TOKEN_GATED, ALLOWLIST, DAO, PAUSED }
setPolicy(...)                       // ERC-20, ERC-721 or ERC-1155 token, minimum balance, token ID
setAllowlisted(...)
pause(...), unpause(...)
checkAccess(bytes32 node, address account) view returns (bool)
~~~
Also write `access.policy` as a text record, so a site can discover it. Ship a small hook, `useAccess(name)`, for sites to use.

**Stated limit:** this gates the interface only. Files on IPFS stay public, so never put secrets in a gated site. Say this in the product.

**Tests:** each policy, wrong owner, pause and resume.

---

## C22. Landing page

**Does:** `/` in the web app. What the product is, how it works, and links to deploy and Verify. No third-party scripts or fonts.

---

## C23. CI

**Repo CI, `ci.yml`:** on every PR, run Vitest, non-fork `forge test` and `gitleaks`, with no secrets.

**Deploy-from-Actions template, `release.yml`:** an alternative to the server, for teams who'd rather build in their own CI. Pin actions to full commit SHAs.

~~~yaml
name: release
on:
  pull_request:          # never pull_request_target
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:                 # no secrets
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with: { ref: "${{ github.sha }}", persist-credentials: false }
      - uses: pnpm/action-setup@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm --filter site build
      - uses: actions/upload-artifact@<sha>
        with: { name: site, path: site/dist, if-no-files-found: error }

  publish:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: build
    runs-on: ubuntu-latest
    environment: preview-publish
    steps:
      - uses: actions/checkout@<sha>
        with: { ref: "${{ github.sha }}", persist-credentials: false }
      - uses: pnpm/action-setup@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - uses: actions/download-artifact@<sha>
        with: { name: site, path: release }
      - run: pnpm ensure publish release
        env:
          PINATA_JWT: ${{ secrets.PINATA_JWT }}
          PREVIEW_PRIVATE_KEY: ${{ secrets.PREVIEW_PRIVATE_KEY }}
          SEPOLIA_RPC_URL: ${{ secrets.SEPOLIA_RPC_URL }}
      - uses: actions/upload-artifact@<sha>
        with: { name: receipt, path: receipt.json }
~~~

**Repo settings:** protect `main`, restrict the `preview-publish` environment to `main`, `CODEOWNERS` on `.github/` and `scripts/`.

**Test:** push to `main` and watch preview update. Open a PR from a fork and confirm no secrets reach any job.

---

## C24. Demo and submit

Run the script in [TECH_AND_DEMO.md section 5](./TECH_AND_DEMO.md#5-demo).

- [ ] Repo public, full history scanned for secrets.
- [ ] Live demo works in a fresh browser.
- [ ] README: setup, addresses, explorer links, verified source, ENS commit, limitations.
- [ ] Note for ENS: which ENSv2 features the flow uses, with real tx hashes.
- [ ] Check ETHGlobal's rules on prior work and reused code.

---

## Done means

- [ ] A new user logs in, connects a repo and deploys from the browser, with live logs.
- [ ] A push to a connected branch deploys that exact SHA.
- [ ] A quick deploy opens a live site under an ENSv2 name.
- [ ] A protected deploy writes preview only. The publisher's production write reverts.
- [ ] Builds see no secrets.
- [ ] `preview` and `prod` are ERC-1155 tokens the owner holds, and can't be transferred.
- [ ] One Promote updates all three records in one transaction.
- [ ] Rollback and recover restore records with no rebuild.
- [ ] Recovery can't add a release. Only `promote` stores one.
- [ ] Verify works with no wallet and no server.
- [ ] Changed resolver, record, manifest or file each gives MISMATCH.
- [ ] Dead RPC or gateway gives UNAVAILABLE, never green. Quick names give UNPROTECTED.
- [ ] CLI, bot, deploy log, config, IPNS and access control work, or are listed as cut.
- [ ] No hard-coded success values.

---

## Questions for the ENS team

1. Any objection to registered tokens for `preview` and `prod`, rather than reserved entries?
2. Which viem version is right for ENSv2 on Sepolia?
3. Is `07e55a05…` still the Sepolia deployment on submission day?
