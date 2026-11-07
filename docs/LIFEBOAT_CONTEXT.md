# ENSure: Shared Context

**Updated:** 2026-11-06
**Canonical project:** ENSure. A platform for deploying websites to ENS, with ENS Lifeboat (verification and recovery) built on top
**Current state:** The base deploy backend is built and tested on a local Sepolia fork. Nothing is deployed live. The website and the Lifeboat layer are next.

This is the single starting point for every teammate and work session. System design is in [ARCHITECTURE.md](./ARCHITECTURE.md), and build steps are in [BUILD_SPEC.md](./BUILD_SPEC.md).

---

## 1. Pitch

**One line:** ENSure deploys a website from a repo to an ENS name in one click, then lets a project protect it: separate publishing roles, owner approval, public verification, and recovery if the publishing path is compromised or unavailable.

**Visitor-facing line:** "Before you connect your wallet, check that this ENS website is still serving the build its owner approved."

**Defensible positioning:**
> GitHub tells the team what code changed, and ENSure deploys it. ENS Lifeboat makes the ENS publishing authority and recovery path explicit, then lets users check whether a known project name points to the recorded release.

This is bigger than "deploy a site to IPFS". A project registers a release identity in ENSv2, ties each release to evidence, separates routine publishing from approval and recovery, and lets visitors verify the result.

No idea guarantees a top-10 result. Competitiveness comes from a working end-to-end demo, real ENSv2 permissions, and honesty about trust boundaries.

## 2. The problem

1. A Web3 frontend is as important as its contracts: users rely on it to understand and sign wallet transactions.
2. A frontend can change after users trust its URL (malicious replacement, bad deploy, compromised CI key).
3. If the site goes down, users may not know where the legitimate interface is.
4. Files on IPFS are not enough: the ENS pointer, publisher keys, and recovery procedure are all part of the attack surface.
5. Git records source revisions, but not which static files the public ENS name serves or whether an owner approved them.
6. A verifier cannot prove code is safe or an ENS name authentic by itself. Users need a **known project ENS name** to start from.

## 3. What the product does

**Base: deploy to ENS**
1. Log in with GitHub or Google, connect a repo, or paste a repo URL.
2. Deploy from the website, CLI, Telegram bot, or automatically on push, with live build logs.
3. Detects the framework and package manager, and builds in a sandbox with no secrets.
4. Pins the site to IPFS through Pinata.
5. Publishes under an ENS name: an auto-assigned quick name, or the user's own name, proved by wallet signature.
6. Keeps a deploy history on-chain, config in ENS text records, optional IPNS for previews, and optional access policies.

**Lifeboat: on top of the base**
7. Sets up a protected identity under ENSv2 (parent, preview, prod, recovery).
8. Creates a **Release Manifest / Release Passport** binding commit, build run, file hashes, site CID, and approval.
9. Publishes candidates to a **preview** ENS name using a preview-only key.
10. Lets the owner approve one candidate for **production** with a wallet or Safe transaction.
11. Lets a visitor verify production without a wallet: ENS → controller → manifest → files.
12. Provides a **recovery path**: restore a previously approved release when routine publishing is compromised or disabled.

A successful build creates a candidate. On a protected name, it never publishes to production. Quick names go straight live, make no approval claim, and Verify reports them as UNPROTECTED.

## 4. Why ENSv2 is essential

ENS is the project's **publishing identity and permission system**, not a display label.

| ENSv2 feature | Product use |
| --- | --- |
| Hierarchical / Permissioned Registry | Project owns its namespace, with `preview` and `prod` as ERC-1155 name tokens held by the owner |
| Permissioned Resolver (separate instances) | Preview and production have separate writer boundaries |
| Enhanced Access Control | Publisher writes preview only; controller writes production; owner administers; roles are revocable |
| Contenthash (ENSIP-7) | Public name points at the approved IPFS site CID |
| Text records | `ensure.manifest`, `ensure.release` carry evidence pointers |
| Resolver multicall | Contenthash and evidence change atomically |
| Universal Resolver V2 | Verifier reads what the name actually serves |

Resolver roles apply to every name served by one resolver instance, so two resolvers are a required security boundary. Text roles can be key-scoped; contenthash permission is resolver-wide.

Deferred ENSv2 features: record linking, wildcard resolution, per-release subnames. The MVP uses explicit registry entries for a clear authorization path.

## 5. Roles and authority

| Actor | Can do | Cannot do |
| --- | --- | --- |
| **Server publisher** (one key, no production rights) | Write preview contenthash and manifest text on names it was granted; write quick names; log deploys | Write any production resolver, administer roles, link, or upgrade |
| **Owner Safe** | Promote, roll back, administer registry pointers, roles, and resolver upgrades; revoke the publisher | n/a (root of trust) |
| **ENSureReleaseController** | Write production contenthash plus `ensure.manifest` and `ensure.release` | Anything else; checks registry pointer first |
| **Recovery authority** (Lifeboat addition: separate Safe or multisig) | Restore a *previously approved* release with a recorded reason | Promote a new, never-approved release; administer roles |
| **Visitor** | Read and verify | n/a |

The owner Safe stays the root of trust. A change that bypasses the controller must appear as a mismatch in Verify. Recovery cannot introduce new content, only re-select stored, approved content.

## 6. Scope

**In scope: everything.** Every feature of the earlier deploy platform is rebuilt here, plus Lifeboat. The full list is in [ARCHITECTURE.md section 3](./ARCHITECTURE.md#3-every-feature-and-where-it-goes).

| Area | Decision |
| --- | --- |
| Build source | Any GitHub repo: connected, or by URL, with branch and subfolder |
| Build runner | Docker sandbox on our server, with no secrets. A GitHub Actions template as an alternative |
| Commit | The exact pushed SHA |
| Storage | Pinata pins site directory and manifest on IPFS |
| Naming | ENSv2 quick names under a platform parent; protected projects get `preview` and `prod` tokens |
| Permissions | Separate Permissioned Resolvers for preview and production |
| Approval | Owner wallet or Safe calls `ENSureReleaseController` |
| Recovery | Separate recovery authority restores an approved release |
| Public check | Verify page and CLI read ENSv2, controller, manifest, and files, never our server |
| Clients | Website, CLI, Telegram bot |
| Network | Sepolia, after confirming live V2 deployment and ABI |

### Optional stretch (only if core works)

- **Arkiv:** store Release Passports as queryable entities, with a user-facing release-history view or verifier lookup that **reads** Arkiv. Write-only logging does not count. If included, supply schema, queries, and judging docs.
- Gateway latency measurement and resilient retrieval.
- Multiple pinning providers.

### Not building

Swarm replication, World ID, AI code scanning, governance voting, automatic incident attribution, DeFi record templates.

The project is independent. No code is copied from earlier work, and historical inspiration isn't named in code, issues, or demo copy.

## 7. End-to-end flows

### A. Deploy a site (the base)
1. Log in, then pick a repo or paste its URL.
2. Choose a quick name, or a verified name of your own.
3. Deploy. Logs stream live while the server builds in a sandbox and pins to IPFS.
4. Quick name: the site is live. Protected name: it's on preview, waiting for the owner.

### A2. Set up a protected project
1. Maintainer connects a wallet and proves ownership of the ENSv2 parent name.
2. Create the child Permissioned Registry and register `preview` and `prod` as tokens, each with its own resolver.
3. Deploy the controller and assign roles (Section 5). The UI shows exactly which account can do each action.

### B. Publish a protected release
~~~text
1. Developer pushes a commit, or clicks Deploy.
2. The server fetches that exact SHA and builds static files with no secrets.
3. It hashes every file and creates a canonical manifest.
4. Pinata pins the site directory → site CID.
5. It adds site CID to the manifest, pins it → manifest CID.
6. It retrieves both artifacts, then updates preview ENS only.
7. Owner reviews the candidate and signs Promote.
8. Controller updates production contenthash and evidence records atomically.
9. Visitor verifies production ENS → controller → manifest → file hashes.
10. Owner or recovery authority can restore an earlier approved release.
~~~

### C. Verify a site
Visitor starts from the project's **known ENS name** (not an arbitrary name from a stranger), and the page reports which checks passed or failed and what the result does and does not establish. Detailed steps are in Section 11.

### D. Recover the site
1. The normal publishing path is lost, compromised, or disabled.
2. Owner revokes the publisher role (or disables the path).
3. Recovery authority reviews release history and selects a previously approved release.
4. Controller restores all three production records in one multicall, with a reason recorded in the event.
5. Visitor verifies the restored site against its manifest.

## 8. Artifacts and records

**Two CIDs per build**
1. **Site CID:** static website directory.
2. **Manifest CID:** canonical JSON describing the release.

**Production ENS records**

| Record | Value |
| --- | --- |
| contenthash | ENSIP-7 encoded IPFS site CID |
| `ensure.manifest` (text) | Full manifest CID string |
| `ensure.release` (text) | Current approved release ID |

**Manifest (Release Passport content)**
~~~json
{
  "schemaVersion": 1,
  "repositoryId": "immutable GitHub repository ID",
  "repositoryUrl": "connected project URL",
  "commitSha": "full Git commit SHA",
  "workflowRunUrl": "build run URL",
  "siteCid": "complete IPFS directory CID",
  "buildTools": {"node": "version", "packageManager": "version"},
  "files": [
    {"path": "index.html", "size": 1234, "mime": "text/html", "sha256": "hex digest"}
  ]
}
~~~

Rules:
- Exact triggering SHA; sorted, normalized relative paths; SHA-256 per file.
- `manifestDigest` = keccak256 of canonical manifest bytes.
- Store full CID strings; a CID is not a bytes32.
- **One shared canonicalization package** used by the server, CLI, and Verify.
- Public records contain no secrets or private user data.
- The manifest ties an artifact to a commit and run. It does not prove a reproducible build.

## 9. Contract: ENSureReleaseController

Handles promotion, rollback, and recovery. Official ENSv2 registry and resolver contracts handle names and records.

**Immutable config:** ownerSafe, recoveryAuthority, projectNode, productionRegistry, production label `prod`, productionResolver, DNS-encoded full production name.

~~~solidity
promote(bytes contenthashBytes, string manifestCid, bytes32 manifestDigest, bytes32 commitDigest) returns (bytes32 releaseId); // owner only
rollback(bytes32 releaseId);                        // owner only
recover(bytes32 releaseId, string reason);          // recovery authority; approved releases only
currentReleaseId() view returns (bytes32);
getRelease(bytes32 releaseId) view returns (release data);
~~~

Behavior:
- Before every write, require `productionRegistry.getResolver("prod") == productionResolver`.
- Reject empty values; derive release ID from project and artifact digests.
- Store encoded contenthash, full manifest CID, digests, approver, approval time, and previous release ID.
- Write contenthash, `ensure.manifest`, and `ensure.release` in **one resolver multicall**; any failing setter reverts all.
- Emit events for promotion, rollback, and recovery (including reason).
- Rollback and recovery only select stored approved releases; they never rebuild.
- The contract does not build sites, fetch IPFS, assess safety, or issue names. File hashing happens off-chain in the verifier.

**Grokbot handoff** (use after inputs are fixed; review output against the pinned ABI):
> Implement ENSureReleaseController in Foundry using the current official ENSv2 registry and Permissioned Resolver interfaces for the selected Sepolia deployment. Owner is a configured Safe; a separate configured recovery authority may only restore previously approved releases with a reason. Before each write, require productionRegistry.getResolver("prod") to equal the configured productionResolver. Implement promote, rollback, and recover. Use one resolver multicall to set contenthash, ensure.manifest, and ensure.release. Store all data needed for rollback, expose release lookup and currentReleaseId, and emit events. Use DNS-encoded full-name setter arguments and ENSIP-7 contenthash bytes. Include unit tests for authorization, resolver mismatch, atomic updates, promotion, rollback, and recovery. Provide a deployment script reading non-secret config from environment variables. Do not request or print private keys.

After deploying, record the address, chain ID, tx hash, compiler version, and verified source location. Grant the controller only the production contenthash role and key-scoped text setter roles.

## 10. Build and publish pipeline

1. A deploy starts from the website, CLI, bot, or a verified push webhook.
2. Fetch the exact SHA with a short-lived token, in a container that exits before user code runs.
3. Build in a separate container with no secrets, from the committed lockfile.
4. Reject empty output, symlinks, secret-like files, and paths outside the output root.
5. Build the sorted file list and hash each file.
6. Pin the site, add its CID to the manifest, compute `manifestDigest`, pin the manifest.
7. Retrieve the manifest and site entrypoint by CID before touching ENS.
8. Confirm the commit is still the latest on its branch (so a slow old job cannot overwrite a newer preview).
9. Encode the contenthash and write the preview, or the quick name.
10. Save a receipt: commit SHA, build log, site CID, manifest CID, digest, tx hash.

Credentials: the Pinata token and publisher key live on the server. Builds never see them. Owner and recovery keys never reach the server or CI. Teams preferring their own CI can use the GitHub Actions template with a preview-only key.

## 11. Verify page and result states

No wallet needed. Steps:
1. Resolve the name via the ENSv2 Universal Resolver; capture the resolver address. Find the controller from `ensure.controller`, and confirm it belongs to the name's owner.
2. Read contenthash, `ensure.manifest`, `ensure.release`.
3. Compare resolver with the controller's configured resolver and the registry's `prod` entry.
4. Read `currentReleaseId` and release data from the controller.
5. Compare ENS records with the approved release.
6. Fetch the manifest by CID; canonicalize and compare with the onchain `manifestDigest`.
7. Decode contenthash and compare its site CID with the manifest.
8. Fetch site files and compare each SHA-256 with the manifest.
9. Show expected vs observed values, commit, build run, both CIDs, approval tx, previous release, and any recovery events with reasons.

| State | Meaning |
| --- | --- |
| **MATCH** | Every required comparison completed and agreed |
| **MISMATCH** | Data was available but something differed; identify exactly which comparison failed and show the last approved release |
| **UNAVAILABLE** | RPC, ENS, manifest, or IPFS failed before verification finished; never green |
| **UNPROTECTED** | Files match the manifest, but the name has no controller, so nobody approved this release; never green |

Verify checks release consistency and the bytes it fetched. It does not declare code safe. It reads only the chain and public gateways, never our server.

## 12. The memorable demo: live "site rescue" drill

Use a test ENS name and mark the scenario as a controlled demo. Never simulate an attack on a third party. All reads and transactions are live; hard-coded success values fail the goal.

1. Log in, pick a repo, click Deploy; show live logs and a quick name going live. Verify shows **UNPROTECTED**.
2. Push a change to a protected project; show the deploy of that exact commit, and the site and manifest CIDs.
3. The server updates **preview**; the same key's **production** write **reverts**.
4. Owner promotes; Verify shows **MATCH**.
5. Write a different contenthash directly to the production resolver, bypassing the controller; Verify shows **MISMATCH**.
6. Owner revokes the publisher role (normal publishing path off).
7. Recovery authority restores the previous approved release with a reason.
8. Verify shows **MATCH** again; history shows promotion, mismatch window, and recovery.

Three-minute version: deploy → live → push → preview → blocked production write → promote → MATCH → tamper → MISMATCH → recover → MATCH. The full script is in [TECH_AND_DEMO.md](./TECH_AND_DEMO.md#5-demo).

## 13. Network uncertainty (deployment gate)

Prize wording says ENSv2 is live on mainnet. The [ENS deployments page](https://docs.ens.domains/learn/deployments/) lists mainnet V2 contracts but says mainnet registration and resolution continue through V1 until launch completes, and lists Sepolia as running V2. Confirm with ENS and verify onchain behavior. **Do not assume mainnet V2 addresses or ABIs.** Target Sepolia unless a live mainnet V2 path is proven. Pin ABI and addresses before writing integration code.

## 14. Build order and status

Built one component at a time. Details are in [BUILD_SPEC.md section 4](./BUILD_SPEC.md#4-build-plan).

| # | Component | Status |
| --- | --- | --- |
| C1 to C3 | **Foundation:** manifest, ENS library, ENS setup | Built, tested on a fork |
| C4 to C10 | **Base:** database and API, login, GitHub, builder, pin, deploy pipeline, names | Built, tested on a fork with stubbed Pinata and GitHub |
| C11 | **Dashboard pages** | Not started (being built by hand) |
| C12 to C16 | **Lifeboat:** controller, verifier, Verify, Owner and Recover pages | Controller compiles, no tests |
| C17 to C21 | **Rest of the base:** CLI, deploy log and config, Telegram bot, IPNS, access control | Built. Bot's live connection not exercised |
| C22, C23 | Landing page, CI | Not started |
| C24 | Demo and submit | Not started |
| Stretch | Arkiv passports with a real read feature (after C15) | Not started |

Next: a live run with real keys, then C12. C1 to C16 are the complete demo.

### Layout
~~~text
ENSure/
├── contracts/   release controller, deploy log, access control
├── core/        manifest, ENS, setup, pipeline, verifier, API types (shared)
├── server/      API, deploy worker, Docker builder, Telegram bot
├── cli/         terminal client
├── web/         landing, dashboard, Verify, Owner, Recover
├── site/        the demo site that gets deployed
├── scripts/     platform setup
├── deployments/ addresses
├── docs/
└── .github/workflows/
~~~
Stack: Solidity + Foundry; TypeScript on Node with Postgres and Docker; React with wallet integration.

## 15. Track fit

- **ENS Best Use (primary):** ENSv2 names, resolvers, and EAC are live and central; permissions shown in real transactions.
- **Arkiv from scratch (optional):** only if a user-facing feature reads Arkiv; include schema, queries, and docs.
- **CROPS (possible):** works if the product proves users can verify the shipped frontend, with open source, privacy/security disclosures, and a demo of the moment the property matters.

Different tracks have different requirements. Do not add Arkiv to merely mention it, and do not claim censorship resistance just because files are on IPFS.

## 16. What the product cannot claim

- It cannot stop a lookalike ENS name from being registered; users must start from the known name.
- A MATCH is not proof the source is safe.
- A manifest is only as trustworthy as the build and approval process behind it.
- It does not prove who authored a commit or the cause of an outage; commit, run, approver, and tx are investigation evidence only.
- IPFS retrieval requires files to stay pinned; one pin provider or gateway can be slow or down (shown as UNAVAILABLE).
- Recovery needs the recovery authority and earlier release files to remain available.
- Recovery protects against loss of the publishing path, not compromise of the owner Safe.
- Onchain records do not make every part of the service decentralized. Deploys go through our server; Verify does not.
- A compromised server can change previews and quick names, but not a protected production name.
- Access policies gate the interface only. Files on IPFS stay public.

Preserve the distinction between a **verified artifact** and a **safe artifact** in all product copy.

## 17. Team rules

- This repository is the only project codebase.
- No owner or recovery keys on the server, or in CI, source, logs, or chat.
- Builds never see secrets. Keep forked-PR builds separate from any trusted publish job.
- Pin ENSv2 ABI and addresses before contract integration.
- Record a release receipt: full CIDs, commit SHA, build link, manifest digest, ENS tx hashes.
- One production channel per project.
- Cut stretch items before the core demo is at risk.

## 18. Submission requirements

Functions on ENSv2 mainnet or Sepolia; ENSv2 is core to the flow; live demo; accessible open-source code with setup instructions, deployed contract addresses, and clear limitations. The repository is currently private and must become public before submission.

## 19. Decisions still needed

1. Final platform name, demo project name, owner Safe, and recovery authority account.
2. Demo repo.
3. Sponsor-confirmed network, deployment addresses, and ABI version.
4. Whether the sponsor objects to registered tokens for preview/prod on that deployment.
5. RPC provider, IPFS retrieval route, and server host.
6. Whether Arkiv is attempted (only after C15).
7. Confirm: quick names deploy straight live, protected names go to preview first.

These are configuration decisions and do not change the agreed flow.

## 20. 30-second judge pitch

> "ENSure deploys a website from a repo to an ENS name in one click. ENS Lifeboat, on top of it, is a recovery and verification system. A project publishes through ENSv2 with separate roles for preview publishing, production approval, and recovery. Each release is tied to its commit, build hash, and IPFS CID in a manifest. Visitors verify a site from the project's known ENS name, and maintainers can restore production to a previously approved release. In our demo, the deploy server's key is blocked from production, the normal path is disabled, and the recovery authority restores a verified release. ENS controls publication and IPFS serves the files."

## 21. References

- [ENSv2 overview](https://docs.ens.domains/ensv2/overview/)
- [Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/)
- [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/)
- [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/)
- [Subnames](https://docs.ens.domains/ensv2/subnames/)
- [Contract developer guide](https://docs.ens.domains/ensv2/tutorial-contract-developers/)
- [App developer guide](https://docs.ens.domains/ensv2/tutorial-app-developers/)
- [Universal Resolver V2](https://docs.ens.domains/ensv2/universal-resolver-v2/)
- [Network deployments](https://docs.ens.domains/learn/deployments/)
- [ENSIP-7 contenthash](https://docs.ens.domains/ensip/7/)
- [IPFS content addressing](https://docs.ipfs.tech/concepts/content-addressing/)
- [ETHGlobal prize requirements](https://ethglobal.com/events/mumbai/prizes)
