# Reference architecture: a decentralized deploy platform

This is a reverse-engineered description of an earlier "Vercel for IPFS and ENS" codebase, called **the reference system** here. ENSure rebuilds all its features ([list](./ARCHITECTURE.md#3-every-feature-and-where-it-goes)). This file records how it worked and which mistakes not to repeat. That codebase is no longer needed to build ENSure, so file paths below are historical.

**Method.** Findings come from reading all source, config and contract files for architecture and data flow, then for observable behaviour and edge cases. The larger dashboard pages were read in part. **Nothing was built or run**, so "would fail" below means the code reads that way, not that a failure was observed. Pinata behaviour comes from its docs as read on 2026-11-06.

**Licence.** The reference system is GPLv3. Write ENSure's code fresh rather than copying, so it brings no GPL obligations.

---

## 1. What it is

Give it a GitHub repo and a name. It clones, builds, uploads the output to IPFS, records the CID on-chain, and reports gateway URLs.

~~~text
                 ┌────────────────┐  ┌───────────┐  ┌───────────────┐
 Entry points    │ Dashboard      │  │ CLI       │  │ Telegram bot  │   + GitHub push webhook
                 │ frontend/      │  │ cli/      │  │ backend/ bot  │
                 └───────┬────────┘  └─────┬─────┘  └───────┬───────┘
                         │ JWT + SSE       │ SSE            │ direct call
                         ▼                 ▼                ▼
 API           ┌──────────────────┐   ┌──────────────────────────────┐
               │ Go service       │   │ Node service                 │
               │ backend-go/      │   │ backend/                     │
               │ deploy only      │   │ auth, GitHub, domains, sites │
               │ Docker sandbox   │   │ deploy, no sandbox           │
               └──┬─────────┬─────┘   └──┬────────┬─────────┬────────┘
                  │         │            │        │         │
 Storage/naming   ▼         ▼            ▼        ▼         ▼
               Pinata   SubnameRegistry  Kubo   Deploy +   Namespace
               (v3)     (one contract)   node   IPNS       offchain
                                                registries subnames
~~~

There are two overlapping backends, and they don't implement the same flow. Section 9 explains why that matters.

## 2. Repository map

| Folder | Purpose | Stack |
| --- | --- | --- |
| `backend/` | Main API: OAuth, GitHub repos and webhooks, custom-domain checks, deploy pipeline, chain reads, Telegram bot | Node (CommonJS), Express, ethers v6 |
| `backend-go/` | Second deploy service: builds inside Docker, uploads to Pinata, one chain write, SSE streaming | Go 1.23, net/http, go-ethereum |
| `cli/` | Terminal client over the HTTP API | Node, commander, inquirer, ora |
| `contracts/` | Four Solidity contracts, tests, deploy scripts | Solidity 0.8.24, Hardhat, OpenZeppelin v5 |
| `frontend/` | Logged-in dashboard | Next 16, React 19, Tailwind 4, shadcn |
| `web/` | Static marketing site, published to IPFS by script | Next 16, Tailwind 4 |
| `docker/`, `docker-compose.postgres.yml` | Postgres 16 and schema. **Unused by the code** (section 9) | SQL |
| `llms/namespace.txt` | Saved index of Namespace's docs for AI tools. Not runtime | Text |
| Root `README.md` | Product vision. Describes much more than exists (section 9) | |

There is no `.github/workflows` directory. The README shows a CI workflow, but the repo doesn't contain one.

## 3. `backend/` (Node API)

| File | Responsibility |
| --- | --- |
| `src/index.js` | Express setup: helmet, CORS from `FRONTEND_URL`, morgan. Raw body on the webhook route before the JSON parser. Mounts routers and starts the bot |
| `src/auth.js` | Signs and verifies JWTs (7-day default). Reads the token from the `Authorization` header or `?token=` |
| `src/pipeline.js` | `runPipeline`: the deploy orchestrator (section 7.1) |
| `src/builder.js` | Detects Next, Vite, CRA or plain. Rewrites Next config for static export, runs install and build, returns the output directory |
| `src/ipfs.js` | Uploads a directory to a local Kubo daemon (`/api/v0/add`). Warms public gateways |
| `src/chain.js` | Writes `logDeploy` and `register`/`logIPNSUpdate`. Uses the `pending` nonce so back-to-back transactions don't collide |
| `src/ens.js` | Random `adjective-noun-xxxx` subnames, Namespace offchain create/update, ENS registry owner lookups |
| `src/github.js` | Octokit wrapper: repos, branches, webhook create/delete, HMAC-SHA256 signature check |
| `src/store.js` | In-memory maps for sessions, connected repos, deploy records (last 20), domain challenges. All lost on restart |
| `src/db.js` | Optional Postgres pool. Nothing imports it, and `pg` isn't in `package.json` |
| `src/bot.js` | Telegraf bot: `/deploy` guided flow, `/status`, `/cancel`, paste-a-URL auto deploy, AI chat through OpenRouter |
| `src/openclaw.js` | Turns free text into a deploy plan via an LLM, with a regex fallback. LLM output is sanitized before use |
| `upload_web.js` | One-off: uploads `web/out` to Pinata |

### HTTP API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/auth/github`, `/google` and their `/callback` | none | OAuth. In-memory `state` with 10-minute expiry. Redirects to the dashboard with `?token=<jwt>` |
| `GET /api/auth/me` | JWT | Current user |
| `POST /api/auth/logout` | none | Stateless, client drops the token |
| `GET /api/auth/providers` | none | Which logins are configured |
| `POST /api/deploy` | JWT | Runs the pipeline, streams SSE. Limit of 3 concurrent jobs, otherwise 429 |
| `GET /api/deploy/status` | JWT | `{active, max}` |
| `GET /api/sites`, `/:domain`, `/:domain/ipns` | none | Reads the on-chain registries |
| `GET /api/github/repos`, `/repos/:o/:r/branches` | JWT | List repos and branches |
| `POST /api/github/connect` | JWT | Links repo + branch to a domain and creates a webhook |
| `GET`, `DELETE /api/github/connected...` | JWT | List or disconnect |
| `POST /api/github/webhook` | HMAC | Push → 202 → background deploy |
| `POST /api/domains/custom/init`, `/verify`, `/confirm-link` | JWT | Custom ENS challenge flow (section 7.3) |
| `GET /api/domains/custom`, `/:ensName` | JWT | Verified names |

## 4. `backend-go/` (Go deploy service)

| File | Responsibility |
| --- | --- |
| `cmd/server/main.go` | Wiring, routes under both `/api/` and `/api/v1/`, SSE with 15-second heartbeat, atomic job counter, graceful shutdown |
| `internal/config/config.go` | Loads env, fails fast on missing secrets, computes the request timeout as the sum of stage timeouts |
| `internal/auth/jwt.go` | Verifies JWTs with the same secret as the Node service |
| `internal/githubclone/clone.go` | `CloneAndBuild`: one locked-down container that clones and builds, detects the package manager and output directory |
| `internal/ipfs/pinata.go` | Streaming multipart upload to Pinata v3 |
| `internal/chain/subname_registry.go` | Signs and waits for `SubnameRegistry.updateCID` |
| `internal/service/deploy.go` | The pipeline: validate → clone and build → upload → write → return output. Has a `DryRun` flag |

**Routes:** `GET /healthz`; `GET /api/auth/me`; `GET /api/deploy/status`; `POST /api/deploy` (JSON result); `POST /api/deploy/stream` (SSE). The body is `{repoUrl, label, meta, githubToken, dryRun}`.

**Container limits (`clone.go`):** 2 GB memory, 2 CPUs, 512 PIDs, `--cap-drop ALL`, `no-new-privileges`, build timeout, named cache volumes per package manager. `Dockerfile.builder` pre-installs git and corepack so builds start faster.

## 5. `contracts/`

Compiler 0.8.24 with optimizer and `viaIR`. The test file holds about 40 Hardhat cases.

| Contract | Stores | Write access | Notes |
| --- | --- | --- | --- |
| `DeployRegistry` | Per-domain append-only list of `{cid, deployer, timestamp, domain, env, meta}` | **Anyone**, unless the owner enables an allowlist for that domain | Env limited to production, staging or preview. Paginated newest-first |
| `IPNSRegistry` | Domain → IPNS key, latest CID, sequence, update log, up to 10 gateway URLs | First registrant becomes publisher | Sequence must increase. Only logs; it doesn't publish IPNS |
| `SubnameRegistry` | Label → `{owner, cid, timestamps, active, meta}` | Label owner. Contract owner may revoke | First-come `claim`. Validates labels on-chain. **Doesn't touch ENS** |
| `AccessController` | Domain → public, token-gated, allowlist, DAO or paused policy | Single contract owner | `checkAccess` for gating. No code calls it |

All four identify a domain by a plain string, not by ENS ownership. None of them talks to ENS, so "domain" is just a label that anyone can claim.

`scripts/deploy.js` deploys the four in order and prints env lines. `scripts/deploy-ipfs.js` publishes `web/out` to Pinata and logs it on-chain. `eth-sepolia-addresses.json` records a past deployment.

## 6. Clients

### `frontend/`

| Route | Function |
| --- | --- |
| `/` | Landing |
| `/login` | GitHub and Google buttons from `/api/auth/providers` |
| `/dashboard` | Takes `?token=`, stores it in `localStorage`, lists sites and connected repos |
| `/connect` | Stepper: pick repo → configure → success. Custom names sign with `personal_sign`, then submit a tx hash |
| `/deploy` | Repo, branch and folder picker with live log terminal. Remembers the folder per repo in `localStorage` |
| `/projects/[domain]` | Deploy history, IPNS entry, gateway links |

`lib/api.ts` is the whole data layer. It holds JWT helpers and client-side expiry checks. It also has two base URLs (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_AUTH_API_URL`) and an SSE parser built on `fetch` plus `getReader`, because `EventSource` can't send POST bodies or auth headers. **Reuse that streaming idea if you ever need POST streaming.**

There's no wagmi or viem. The only wallet use is raw `window.ethereum` calls for `personal_sign`.

### `web/`

A single page plus `Navbar`, `ProblemSection`, `HowItWorks`, `ENSConfigSection`, `IntegrationsSection` and `Footer`. It uses CSS variables for an ENS-inspired palette. `upload_to_pinata.mjs` publishes the build, but it hard-codes one developer's absolute path to `.env`.

### `cli/`

`init` writes a config file and `.env.example`. `push` streams a deploy. `status`, `rollback` and `env` talk to the API. Section 9 explains why most of it doesn't currently work.

### Telegram bot

The chat front end for `runPipeline`. Useful detail: `makeLogBatcher` groups build logs into one edited message to stay within Telegram's rate limits.

## 7. Core flows

### 7.1 Node deploy

1. Parse `github.com/o/r/tree/branch/sub` into clone URL, branch and subfolder.
2. Shallow clone under `~/.<app>/builds/`. A code comment explains why: macOS temp paths are symlinks, which crash Next workers.
3. Build. The private clone token goes in `http.extraheader`, not the URL.
4. Upload to Kubo → pass-1 CID.
5. **Next only:** rebuild with `assetPrefix = https://ipfs.io/ipfs/<pass-1 CID>` and upload again → final CID.
6. Auto names: update Namespace offchain contenthash. Custom names: report `pending-user-transaction` and stop there.
7. Write `logDeploy`, then `register` or `logIPNSUpdate`.
8. Warm gateways, return a receipt, delete the temp directory.

### 7.2 Go deploy

Validate → one container clones and builds → `.builddir` marker reports the output folder → upload to Pinata → `updateCID` → output.

Output detection tries `out`, then `dist`, `build`, `.next`. Package manager detection uses the lockfile.

### 7.3 Custom ENS name

1. `init`: check owner through the **ENSv1** registry, return a nonce message and generated key.
2. `verify`: recover the signer, check ownership again, mark as verified.
3. The user manually sets the contenthash in a wallet.
4. `confirm-link`: the user submits a tx hash. It only passes a format check.

### 7.4 Push webhook

GitHub → `/api/github/webhook` → look up the connection → verify HMAC → 202 → `runPipeline` in the background → record success or failure in memory.

## 8. Configuration and data

**Env groups:** chain (`SEPOLIA_RPC_URL`, `PRIVATE_KEY`, contract addresses), storage (`PINATA_JWT`, `IPFS_API_URL`, `IPFS_GATEWAY`), auth (`JWT_SECRET`, GitHub and Google OAuth), URLs (`FRONTEND_URL`, `BACKEND_URL`), optional services (Telegram, OpenRouter, HeyElsa, Namespace), and Go timeouts and limits.

**Postgres schema (unused):** `sessions`, `connected_repos`, `deploy_history`, `pending_custom_domains`, `verified_custom_domains`.

**JWT claims:** `sub`, `provider`, `login`, `name`, `email`, `avatar`, `githubToken`.

## 9. What's actually broken or missing

### Claims vs code

| The README says | The code does |
| --- | --- |
| Pins to three providers, success at 2 of 3 | One target: Kubo in Node, Pinata in Go |
| IPNS via w3name, updated each deploy | No w3name code, only mentions in comments. Keys are made-up strings such as `ipns-placeholder:<domain>`, and nothing publishes IPNS |
| ENS contenthash updated on-chain | Never. No `setContenthash` call exists. Only the Namespace offchain path updates a name |
| Multi-sig deploys with Safe | Not implemented. Config placeholder only |
| Token gating read from ENS records | Contract exists, nothing calls it |
| CI workflow | No workflow in the repo |
| "No one can take it down" | Availability still depends on a server, one signing key, and gateways |

### Broken integrations

| # | Location | Problem |
| --- | --- | --- |
| 1 | `frontend/lib/api.ts` | The dashboard sends deploys and GitHub calls to one base URL. `/api/deploy/stream` exists only in Go. `/api/github/*`, `/api/sites` and `/api/domains/*` exist only in Node. Only login goes to the second URL. So neither backend alone serves it, and the repo has no reverse proxy to split them |
| 2 | `frontend/lib/api.ts` | `getSites` and `getSite` turn a 404 into an empty result, which would hide problem 1 behind an empty dashboard |
| 3 | `frontend/lib/api.ts` | `deployStream` sends only `repoUrl`, `label` and `meta`. The form's env, domain mode and IPNS key are dropped |
| 4 | `chain/subname_registry.go` | Calls only `updateCID`, which requires the signer to own a claimed label. Nothing in the Go service calls `claim`, so a new label reverts *after* the build and upload |
| 5 | `internal/ipfs/pinata.go` | Omits `network`, which Pinata documents as defaulting to private. Pinata also documents that v3 doesn't support folder uploads |
| 6 | `cli/src/commands/push.js` | Looks for `obj.type === "log"`. The server sends named SSE events with `{line}`, so logs and the receipt are missed and it reports no receipt |
| 7 | `cli/src/commands/rollback.js`, `env.js` | Call `/api/deploy/rollback` and `/api/domains/:d/records`, which don't exist |
| 8 | `cli/src/commands/status.js` | Hex-decodes CIDs that the API already returns as text |
| 9 | `contracts/package.json` | `deploy:sepolia` targets a network the config calls `ethSepolia` |
| 10 | `backend/src/db.js` | Unused, and its dependency isn't installed |

### Security problems

| Severity | Location | Problem | ENS Lifeboat rule |
| --- | --- | --- | --- |
| Critical | `backend-go/.env.example` | Tracked file containing values shaped like real credentials: signing key, GitHub and Google OAuth secrets, Telegram token, OpenRouter key, Pinata JWT. Also in git history | Only blank placeholders in examples. Add secret scanning |
| Critical | `backend/src/builder.js` | Runs untrusted `npm install` and build scripts on the host with `{...process.env}`, so a repo's scripts can read the signing key and API keys | Secrets never exist in the build step's environment |
| High | `backend/src/routes/auth.js` | GitHub token (full `repo` scope) sits inside the JWT. JWTs are signed, not encrypted, so anyone holding it can read the token. It's also passed in a URL and kept in `localStorage` | No user tokens at all: GitHub Actions has its own |
| High | Both pipelines | One server key signs every chain write for every user. Whoever controls the server controls all history | Separate keys, separate on-chain roles |
| High | `DeployRegistry`, `IPNSRegistry`, `SubnameRegistry` | Anyone can log deploys or claim any domain string, with no tie to ENS ownership, so the "audit trail" can be forged | Authority comes from ENSv2 roles, and Verify checks it |
| High | `routes/domains.js` | `confirm-link` accepts any well-formed hash and never reads the chain | Read state back from chain, never trust a claimed tx |
| Medium | `routes/github.js` | Webhook records `payload.after` but clones the branch tip, so the recorded commit may not be what was built | Check out the exact SHA |
| Medium | `builder.js` | Next 2-pass sets absolute `assetPrefix` to `ipfs.io` and pass-1's CID, so the final CID loads code from a *different* CID via one gateway | Relative asset paths only (see below) |
| Medium | `backend/src/ipfs.js`, `pinata.go` | Plain mode uploads the repo root. No filter for secrets, `.env`, or (in Node) `.git` | Publish one output dir and reject bad files |
| Medium | `builder.js` | Deletes dynamic routes, swaps the Next version and lockfile, and ignores TS and ESLint errors, so what's published differs from the source | Build with the committed lockfile and no rewriting |
| Medium | `clone.go` | Git token in `docker run` args, visible in process listings. CORS `*` | No tokens on command lines |
| Low | `ens.js` | Owner lookup via ENSv1 registry, which reports the wrapper contract for wrapped names and isn't the path ENSv2 uses | Use ENSv2 tooling |

### The trap most relevant to you

Step 5 of the Node flow shows a verification gap that ENS Lifeboat could inherit. Hashing files proves nothing about code a page loads from elsewhere. If the published HTML has `<script src="https://…">` or an absolute asset prefix, all hashes can MATCH while the visitor runs unverified code. See [BUILD_SPEC.md C13](./BUILD_SPEC.md#c13-verifier).

## 10. What carries over

Features: all of them, listed in [ARCHITECTURE.md section 3](./ARCHITECTURE.md#3-every-feature-and-where-it-goes). Fixes for the problems above: [section 8](./ARCHITECTURE.md#8-fixes-over-the-reference-system).

Implementation ideas worth keeping:

| Idea | Used in |
| --- | --- |
| Pipeline as ordered stages with a logger callback | C9 |
| Container limits and cache volumes per package manager | C7 |
| Output detection, and a marker file for the output path | C7 |
| Failing fast on missing config | C4 |
| `dryRun` flag | C9 |
| Receipt at the end of a pipeline | C9 |
| Streaming over `fetch` with `getReader`, since `EventSource` can't POST or send auth | C11 |
| Grouping Telegram logs into one edited message | C19 |
| Assume public RPCs limit batches and log ranges | C13 |
| `pinFileToIPFS` with path-prefixed parts and `cidVersion: 1` | C8 fallback |
| `X-Accel-Buffering: no` and a 15-second heartbeat for SSE behind proxies | C9 |
