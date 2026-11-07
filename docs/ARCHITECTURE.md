# ENSure architecture

ENSure is the only project. It has two layers, built in this one repo:

1. **Base: deploy a website to ENS.** Connect a repo, click Deploy, watch the build, and the site goes on IPFS under an ENS name.
2. **Lifeboat, on top:** separate roles, owner approval, public verification and recovery.

Every feature of the earlier deploy platform (called "the reference system" in these docs) is rebuilt here. No code is copied from it, and nothing here needs it to exist. [REFERENCE_ARCHITECTURE.md](./REFERENCE_ARCHITECTURE.md) keeps the notes on how it worked.

---

## 1. Two kinds of name

| | Quick name | Protected name |
| --- | --- | --- |
| Example | `amber-falcon-3f2a.<platform>.eth` | `prod.<project>.eth` |
| Who owns it | The platform | The user's wallet or Safe |
| A deploy goes | **Straight live** | **To `preview`.** The owner promotes it to `prod` |
| Who can write it | Server key | `preview`: server key. `prod`: only the controller |
| Recovery | None | Rollback and recovery authority |
| Verify result | **UNPROTECTED**, never green | MATCH / MISMATCH / UNAVAILABLE |

Quick names keep the one-click experience of the base product. They make no approval claim, and Verify says so.

---

## 2. System

~~~text
  Entry points
  ┌───────────┐  ┌─────────┐  ┌──────────────┐  ┌───────────────┐
  │ Website   │  │ CLI     │  │ Telegram bot │  │ GitHub push   │
  │ web/      │  │ cli/    │  │ server/      │  │ webhook       │
  └─────┬─────┘  └────┬────┘  └──────┬───────┘  └───────┬───────┘
        └─────────────┴──────┬───────┴──────────────────┘
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ server/  one API, one worker, Postgres                       │
  │ login · GitHub · projects · names · deploy queue · live logs │
  └───────┬──────────────────┬──────────────────────┬────────────┘
          ▼                  ▼                      ▼
  ┌───────────────┐  ┌──────────────┐     ┌────────────────────┐
  │ Docker build  │  │ Pinata       │     │ Sepolia ENSv2      │
  │ NO secrets    │─▶│ site and     │     │ quick names        │
  │ one per deploy│  │ manifest     │     │ preview names      │
  └───────────────┘  └──────────────┘     │ deploy log         │
                                          └────────────────────┘
  Owner wallet ──────▶ Controller ──────▶ prod resolver     (server can't)
  Recovery wallet ───▶ Controller ──────▶ prod resolver     (approved releases only)

  Visitor ──▶ Verify page or CLI ──▶ chain + public IPFS gateways   (no server)
~~~

**The rule that holds it together:** the server can deploy, but it holds no role on any `prod` resolver. A full server compromise can change previews and quick names. It can't change a protected production site.

**Verify never calls the server.** It reads only the chain and public gateways, so a compromised server can't fake a result.

**One language.** Everything except contracts is TypeScript, so the server, CLI and browser share one copy of the manifest and ENS code. See [TECH_AND_DEMO.md](./TECH_AND_DEMO.md).

---

## 3. Every feature, and where it goes

### From the reference system

| Feature | How ENSure does it | Component |
| --- | --- | --- |
| GitHub login | GitHub App user login, server-side session | C5 |
| Google login | OAuth, public-repo deploys only | C5 |
| List repos and branches | GitHub App API | C6 |
| Connect repo to a name | `projects` table, webhook from the App | C6 |
| Auto-deploy on push | Verified webhook, builds the **exact pushed SHA** | C6, C9 |
| Deploy from any repo URL, including `/tree/branch/subfolder` | URL parser, subfolder and branch support | C7 |
| Framework detection (Next, Vite, CRA, plain) | Detect, then build unmodified | C7 |
| Package manager detection | Lockfile picks npm, pnpm or yarn | C7 |
| Sandboxed Docker builds, build cache | Locked-down container per deploy, cache volumes | C7 |
| Upload to IPFS | Pinata | C8 |
| Warm gateways | Fetch-back step does this | C8 |
| Live build logs | SSE, one event format | C9 |
| Concurrency limit | Postgres-backed queue | C9 |
| Deploy receipt | Stored and returned | C9 |
| Dry run | `dryRun` flag | C9 |
| Auto-assigned names | Real ENSv2 subnames in a platform registry | C10 |
| Custom ENS names with wallet proof | Signed challenge plus an ENSv2 owner read | C10 |
| Dashboard, connect, deploy and project pages | One web app | C11 |
| Landing page | One web app | C22 |
| CLI: `init`, `push`, `status`, `rollback`, `env` | All working, against one API | C17 |
| On-chain deploy log | `DeployRegistry`, gated by ENS ownership | C18 |
| ENS text records as config | `ensure env` and project page | C18 |
| Telegram bot, guided and paste-a-URL deploys | Bot in the server, linked to a user account | C19 |
| AI deploy planner and chat | LLM with a regex fallback, output validated | C19 |
| IPNS key and update log | Real IPNS publishing, key in a text record | C20 |
| Token gating, allowlist, DAO, pause | `AccessController`, gated by ENS ownership | C21 |
| Hardhat contract tests | Foundry tests | C12, C18, C21 |
| Postgres schema | Actually used this time | C4 |

### Promised in its README but never built

| Feature | ENSure |
| --- | --- |
| On-chain ENS contenthash updates | **Built.** This is the core of the product |
| Safe-owned production | **Built** (C12, C15) |
| Rollback | **Built** on-chain (C12, C15, C17) |
| CI workflow for deploys | **Built** as `release.yml` (C23) |
| Multiple pinning providers | Not built. One provider, stated as a limit. Add later |
| DeFi record schemas and templates, ERC proposal | Not built. Roadmap items, not features |

### New Lifeboat features

Separate preview and production resolvers, role-based permissions, release manifest, owner Promote, recovery authority, public Verify page and CLI. Components C3, C1, C12 to C16.

---

## 4. Keys and authority

| Key | Lives in | Can | Can't |
| --- | --- | --- | --- |
| Server publisher | Server env | Write preview names it was granted, write quick names, register quick names, log deploys | Touch any `prod` resolver |
| Pinata JWT | Server env | Upload | Anything on-chain |
| GitHub App key | Server env | Get short-lived tokens for repos it's installed on | Reach other repos |
| Owner | User's wallet or Safe | Promote, roll back, administer roles | n/a. Root of trust |
| Recovery | Separate wallet or Safe | Restore an approved release | Add a release, administer roles |

**Build containers get no keys.** Cloning uses a short-lived token in a separate container, which is gone before user code runs.

**Stated limits:**
- A compromised server can change previews and quick names, and it runs builds. Owners still review before promoting.
- Build containers run untrusted code on the server's host, so keep it a dedicated machine holding only these keys.
- Static-site token gating is a UI gate. The files are public on IPFS.
- One pinning provider is a single availability dependency.

---

## 5. Flows

**Quick deploy**
~~~text
Login → paste or pick repo → Deploy → build (live logs) → pin
→ register <random>.<platform>.eth → write contenthash and manifest → log deploy → live
~~~

**Set up a protected project** (user's wallet signs each step)
~~~text
Connect wallet → prove ownership of <project>.eth → deploy child registry and two resolvers
→ register preview and prod tokens → deploy controller → grant roles
→ write ensure.controller → project ready
~~~

**Protected deploy**
~~~text
Push or Deploy → build exact SHA → pin → write PREVIEW → log deploy
→ owner reviews evidence → Promote → controller writes prod in one transaction
~~~

**Verify:** enter a known name → read chain and gateways → result.

**Recover:** owner or recovery wallet → pick an approved release → controller restores all three records.

---

## 6. API

JSON over HTTPS, session cookie for the website, bearer token for the CLI.

| Route | Purpose |
| --- | --- |
| `GET /auth/github`, `/auth/google`, and callbacks | Login |
| `POST /auth/logout`, `GET /auth/me` | Session |
| `POST /auth/cli-token` | Issue a revocable CLI token |
| `GET /github/repos`, `/github/repos/:o/:r/branches` | Repo picker |
| `POST /github/webhook` | Push events, signature checked |
| `GET`, `POST /projects`, `GET`, `DELETE /projects/:id` | Connected repos and names |
| `POST /names/custom/challenge`, `/names/custom/verify` | Prove ownership |
| `POST /deploys` | Queue a deploy |
| `GET /deploys/:id`, `/deploys/:id/events` | Status, live logs over SSE |
| `GET /projects/:id/deploys` | History |

Reading chain state (roles, records, releases) goes straight from the client to the chain, not through this API.

---

## 7. Data

| Table | Holds |
| --- | --- |
| `users` | Provider, provider ID, login, Telegram ID |
| `sessions` | Hashed token, user, kind (web or CLI), expiry |
| `projects` | Owner, repo ID, branch, subfolder, name mode, ENS name, resolver and controller addresses, env |
| `name_challenges` | Name, wallet, nonce, expiry |
| `deploys` | Project, commit SHA, status, CIDs, digests, tx hashes, error, timestamps |
| `deploy_logs` | Deploy, sequence, line |

Chain and IPFS are the record of what was approved. Postgres only supports the app: losing it stops deploys, but not Verify, Promote or Recover.

---

## 8. Fixes over the reference system

| It did | ENSure does |
| --- | --- |
| Two backends with different routes, no proxy | One API |
| Clients each parsing a different stream format | One SSE format, shared types |
| CLI calling routes that don't exist | CLI built against the shared API types |
| Server keys visible to build scripts | Builds get no secrets |
| Git token inside a readable JWT, in URLs, in `localStorage` | Short-lived App tokens, HTTP-only session cookie |
| Secrets committed to an example env file | Blank example, `gitleaks` in CI |
| Anyone could log a deploy or claim any domain string | Writes gated by ENS ownership |
| Accepted any tx hash as proof | Reads chain state |
| Rewrote Next config, deleted routes, swapped versions | Builds as committed. Fails clearly if the app can't export static files |
| Assets pointed at another CID through one gateway | No rewriting. Sites load from their own CID |
| Recorded a commit but built the branch tip | Checks out the exact SHA |
| Fake IPNS keys | Real IPNS publishing |
| All state in memory | Postgres and a persistent queue |

---

## 9. Defaults to confirm

Both are easy to change now, and harder later.

1. **Quick names deploy straight live, protected names go to preview first.** It keeps one-click deploys and the approval story, with Verify showing the difference.
2. **Demo deploys your own repo on stage.** The feature accepts any repo, but your own is the reliable choice live.
