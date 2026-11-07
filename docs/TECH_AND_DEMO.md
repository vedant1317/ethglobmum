# Tech and demo

Which tool is used for each feature, and what we show, start to end.

[BUILD_SPEC.md](./BUILD_SPEC.md) wins on behaviour. This file wins on tool choice. Install the latest stable versions and let the lockfile pin them.

---

## 1. Language decision

**TypeScript everywhere, Solidity for contracts. No Go.**

| Part | Language |
| --- | --- |
| Contracts | Solidity |
| Server, worker, bot | TypeScript on Node |
| Manifest, ENS library, pipeline, verifier | TypeScript |
| CLI, website | TypeScript |
| Build sandbox | Docker, driven from Node |

### Go or TypeScript for the server?

The product does need a server now, which is the case for Go. TypeScript still wins:

| Question | Go | TypeScript |
| --- | --- | --- |
| Manifest code must match Verify exactly, and Verify runs in the browser | Needs a second copy, which can disagree by one byte, or a separate process | **One copy shared everywhere** |
| Running Docker builds | Good | **Just as good.** The real work is in the container, and starting one is a `docker run` call |
| ENSv2 tooling | No Go library in the docs we read | **viem is what the docs use** |
| Pinata | Plain HTTP | Plain HTTP |
| API types shared with website and CLI | Generated or duplicated | **Direct import**, so clients can't drift |
| Load | Better at high traffic | Fine: one queue with a few builds at a time |

The reference system's Go service was good at sandboxed builds, and those ideas carry over: its container limits and its output detection. Its two-backend split, where different routes lived in different services, is what broke its dashboard.

**Revisit Go only if** the worker needs to scale far beyond a demo. It's a contained rewrite of `server/src/builder.ts`.

**Next.js isn't used either.** The website is static with a separate API, and Vite does that with no server runtime. Next stays *supported as a framework that users deploy*.

---

## 2. Stack by component

### Shared

| Need | Tool |
| --- | --- |
| Monorepo | pnpm workspaces |
| Language | TypeScript, `strict` |
| Tests | Vitest, Foundry |
| Run scripts | `tsx` |
| Ethereum client | viem |
| Chain | Sepolia, chain ID 11155111 |
| RPC | One keyed provider first, public RPCs behind it, viem `fallback` |
| Explorer | Sepolia Etherscan |
| Node | Current LTS, pinned in `.nvmrc` |

### Foundation

| Component | Feature | Tech |
| --- | --- | --- |
| C1 Manifest | SHA-256 | `@noble/hashes` (browser-safe) |
| | keccak256 | viem |
| | Canonical JSON | Our own short function. The bytes are the contract |
| | MIME | Our own extension table |
| C2 ENS library | DNS names | `viem/ens` `normalize`, `packetToBytes` |
| | Contenthash | `multiformats` and the `0xe301` prefix |
| | Calls | viem, `parseAbi` fragments from the pinned ENS commit |
| | Roles | `bigint` constants, tested against the source values |
| C3 ENS setup | Deploy proxies | `VerifiableFactory.deployProxy` with viem |
| | Addresses | viem `parseEventLogs` on `ProxyDeployed` |
| | Prove permissions | viem `simulateContract`, expecting reverts |
| | Safe-owned steps | Calldata for Safe{Wallet} Transaction Builder |
| | Debugging | `cast` |

### Base: deploy to ENS

| Component | Feature | Tech |
| --- | --- | --- |
| C4 Database and API | HTTP | Hono on Node |
| | Database | Postgres, `postgres` driver, plain SQL migrations |
| | Validation | `zod` |
| | Local setup | Docker Compose |
| C5 Login | GitHub | GitHub App user login over `fetch` |
| | Google | OAuth over `fetch`, no SDK |
| | Sessions | Random token stored as a SHA-256 hash, HTTP-only cookie |
| C6 GitHub | API | `fetch`, installation tokens from a signed App JWT (`node:crypto`) |
| | Webhook | HMAC-SHA256 with `crypto.timingSafeEqual` |
| C7 Builder | Sandbox | Docker, `node:child_process`, custom builder image |
| | Package managers | corepack: npm, pnpm, yarn |
| | Frameworks | Detection from `package.json`: Next, Vite, CRA, plain |
| C8 Pin | Site | `fetch` and `FormData` to `pinFileToIPFS`, the route Pinata documents for folders |
| | Manifest | `fetch` to `/v3/files` with `network=public` and exact bytes |
| | Bad output | `node:fs` `lstat`, path checks, secret-pattern list |
| | Fetch back | `fetch`, public gateways, retry with backoff |
| C9 Deploy pipeline | Queue | The `deploys` table with `FOR UPDATE SKIP LOCKED`, no queue library |
| | Live logs | Server-Sent Events, Hono `streamSSE` |
| | Chain writes | viem `privateKeyToAccount`, `writeContract` |
| C10 Names | Random labels | `node:crypto` |
| | Ownership proof | viem `verifyMessage`, supports contract wallets |
| | Owner read | `UniversalHelper.findExactOwner` |
| C11 Dashboard | App | Vite, React, TypeScript, Tailwind |
| | Routing | `react-router` |
| | Data | `@tanstack/react-query` |
| | Log terminal | `fetch` streaming |

### Lifeboat

| Component | Feature | Tech |
| --- | --- | --- |
| C12 Controller | Contract | Solidity 0.8.24, no OpenZeppelin |
| | Tests | `forge test`, `forge-std`, mock resolver, Sepolia fork |
| | Deploy | `forge script` with a keystore. viem `deployContract` in the wizard |
| | Source | `forge verify-contract` |
| C13 Verifier | Reads | viem public client, `fallback` |
| | History | viem `getLogs`, paged |
| | Fetches | `fetch`, `AbortController`, own failover |
| | Script warning | `parse5`, works in Node and browser |
| | Writer warning | `getAssigneeCount` |
| C14 Verify page | App | Same web app. **viem only, no wallet libraries on this route** |
| | Security | Strict Content-Security-Policy, no third-party requests |
| C15 Owner page | Wallet | wagmi, viem, lazy-loaded |
| | Connectors | Injected, WalletConnect |
| | Safe | WalletConnect to Safe{Wallet}, or calldata |
| C16 Recover page | Same as C15 | Form gated by `recoveryAuthority()` |

### Rest of the base

| Component | Feature | Tech |
| --- | --- | --- |
| C17 CLI | Commands | `commander` |
| | Token | `~/.ensure/token` (mode 600), or environment |
| C18 Deploy log and config | Contract | Solidity, Foundry |
| | Config | ENS text records |
| C19 Telegram bot | Bot | `grammy` |
| | AI | OpenRouter over `fetch`, `zod` on output, regex fallback |
| C20 IPNS | Publishing | A Kubo node's HTTP API, off unless `KUBO_API_URL` is set |
| C21 Access control | Contract | Solidity, Foundry |
| | Client hook | wagmi `useReadContract` |
| C22 Landing page | Page | Same web app |
| C23 CI | Runner | GitHub Actions |
| | Secret scan | `gitleaks` |
| C24 Demo | Backup | Screen recording |

---

## 3. What runs where

| Thing | Runs on | Secrets |
| --- | --- | --- |
| `web/` | Static host. Not IPFS sites it checks | None |
| `server/` with Docker and Postgres | One small VPS. Serverless hosts can't run Docker builds | Publisher key, Pinata JWT, GitHub App key, session and bot tokens |
| Build containers | Same VPS | **None** |
| Deployed sites | IPFS, pinned through Pinata | None |
| Contracts, names | Sepolia | n/a |
| Owner, recovery keys | Users' wallets | Never on the server |

---

## 4. Decide before the demo

| Decision | Recommendation |
| --- | --- |
| Owner on stage | Safe with threshold 1 of 2 owners, if each transaction takes under 30 seconds in rehearsal. Otherwise an EOA on the demo name, and say so |
| Platform and project names | Decide now. Every URL depends on them |
| Demo site | One page showing its commit SHA, so each release looks different |

---

## 5. Demo

### What a user experiences

**A developer:** logs in with GitHub, picks a repo, clicks Deploy, watches logs, and gets a live ENS name. To protect it, they connect their own name and approve each release.

**A visitor:** enters a project's known ENS name on the Verify page, with no wallet. They get a result, the 15 checks with expected next to observed, the release details, a timeline, who can write the name, and a link that opens the exact CID checked. Every result carries: *"This checks the release matches what the owner approved. It doesn't mean the code is safe."*

### Pages

| Page | Wallet | Shows |
| --- | --- | --- |
| `/` | No | What it is, links to deploy and Verify |
| `/login`, `/dashboard`, `/connect`, `/deploy` | No | Repo picker, live logs, receipts |
| `/projects/:id` | No | History, records, gateways, config |
| `/projects/:id/owner` | Owner | Candidate evidence, Promote, Rollback, revoke publisher |
| `/projects/:id/recover` | Recovery | Approved releases, reason, Recover |
| `/verify` | **None** | Result, checks, release, timeline, roles, warnings, open-site link |

### Before going on stage

- Protected project set up, with two approved releases: R1, then R2 current.
- One connected repo, with a commit ready to push.
- Fresh browser profiles: **Developer** (GitHub logged out), **Owner**, **Recovery**, **Visitor** (no wallet).
- Tabs: GitHub, Etherscan, a terminal.
- Funded accounts, a full recording, and a banner on the demo site: "Controlled demo on a test name."

### Script

About 6 minutes. All reads and transactions are live.

**Part 1: deploy to ENS (the base product)**

| # | Time | Do | They see | Component |
| --- | --- | --- | --- | --- |
| 1 | 0:00 | Open the landing page, one line on the problem | What ENSure does | C22 |
| 2 | 0:15 | Developer: log in with GitHub, pick the demo repo, choose a quick name, **Deploy** | Live build logs start | C5, C6, C9, C11 |
| 3 | 0:30 | Keep talking while it builds | Framework detected, build, pin, CIDs appear | C7, C8, C9 |
| 4 | 1:15 | Click the result | **Site live under an ENS name**, deployed from a repo in about a minute | C10 |
| 5 | 1:25 | Open that name in Verify | **UNPROTECTED**: files match, but nobody approved this. *"Deploying is the easy part. What if this key is stolen?"* | C14 |

**Part 2: protect it (Lifeboat)**

| # | Time | Do | They see | Component |
| --- | --- | --- | --- | --- |
| 6 | 1:45 | Open the protected project in Verify | **MATCH** on R2, and the role table: server on preview only, controller on production, owner administers | C14 |
| 7 | 2:05 | `git push` to the connected repo | Webhook starts a deploy of that exact SHA, with live logs | C6, C9 |
| 8 | 2:45 | Deploy finishes | **Preview updated, production unchanged**, `prodWriteBlocked: true` | C9 |
| 9 | 2:55 | Terminal: simulate a production write from the server's key | **Reverts** | C3 |
| 10 | 3:10 | Owner page: review evidence, **Promote** | One transaction, three records. **Live** only after read-back agrees | C12, C15 |
| 11 | 3:40 | Visitor: Verify, then open the site | **MATCH**, new release | C14 |

**Part 3: the rescue**

| # | Time | Do | They see | Component |
| --- | --- | --- | --- | --- |
| 12 | 4:00 | Owner writes a different contenthash straight to the production resolver | A write that bypasses the controller, on Etherscan | C12 |
| 13 | 4:15 | Visitor: Verify | **MISMATCH**, naming the failing check and the last approved release | C13, C14 |
| 14 | 4:35 | Owner page: revoke publisher | Publishing path off. Role table updates | C15 |
| 15 | 4:50 | Recovery: pick R2, enter a reason, **Recover** | Event with the reason | C12, C16 |
| 16 | 5:20 | Visitor: Verify | **MATCH**. Timeline shows the whole incident | C14 |
| 17 | 5:35 | Test toggle: dead RPC | **UNAVAILABLE**, never green | C14 |
| 18 | 5:45 | Close | What MATCH doesn't mean, the stated limits, one-line pitch | |

**Three-minute cut:** 2, 4, then 7, 8, 10, 11, 12, 13, 15, 16. Start the deploy in step 2 before you begin talking, and use a project already mid-build if needed.

### Optional extras, if a judge asks

| Show | Command or page | Component |
| --- | --- | --- |
| Deploy from a terminal | `ensure push` | C17 |
| Verify with no browser | `ensure verify <name>` | C17 |
| Deploy from a chat | Paste a URL to the bot | C19 |
| Access gate | Demo page with a token policy | C21 |

### Lines to say

- *"The server deploying your site can't touch your production name. The contract enforces that, and you just saw it revert."*
- *"MISMATCH names the exact comparison that failed."*
- *"Recovery can only restore a release the owner already approved."*
- *"Revoking the publisher doesn't change production, because it never had access. The separate resolver is what protected it."*
- *"If the owner Safe itself is compromised, recovery can't help. That's a stated limit."*

### Don't say

- That MATCH means the code is safe.
- That the site can't be taken down. IPFS needs pinning, and we use one provider.
- That this stops lookalike names.
- That step 12 is an attack. It's a controlled write that bypasses the controller.
- That the whole service is decentralized. Deploys go through our server. Verify doesn't.

### If something fails

| Failure | Response |
| --- | --- |
| Build is slow | Keep a finished deploy in another tab and move on |
| Safe is slow | Narrate the role table, or switch to the EOA owner |
| Sepolia is congested | Use the recording for that step |
| A gateway is down | The verifier tries the next. If all fail, that's the UNAVAILABLE demo |
| Server is down | Part 3 still runs: Promote, Verify and Recover don't need it |
