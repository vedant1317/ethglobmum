# Codex prompt: build the ENSure frontend (`web/`)

Copy everything below the line into Codex. Do not invent addresses. Do not add names from any other project.

---

## Mission

Build the **ENSure** frontend in the repository folder `web/` using **TypeScript**.

ENSure lets a team publish a static site through **ENSv2 on Sepolia** and lets visitors check that the production name still serves the owner-approved release.

Work only inside this ENSure repo. Name the product **ENSure** everywhere (UI copy, package name, comments). Do not mention any other project names or prior demos.

## Stack (required)

Prefer this stack (fits the rest of ENSure and the Arkiv TS SDK, which peers on `viem`):

- **Vite + React + TypeScript** (or Next.js App Router if you strongly prefer; Vite is enough for a static Verify/Owner UI)
- **viem** + **wagmi** + **@tanstack/react-query** for Sepolia reads/writes and MetaMask
- **Tailwind CSS** for layout
- Optional behind a feature flag: **`@arkiv-network/sdk`** (npm latest **1.0.1** as of 2026-11-06) + `viem` for an Arkiv history panel (read-only on the client)

Do **not** put private keys in the frontend. Owner actions go through MetaMask (`wagmi` / EIP-1193).

## Live Sepolia facts (source of truth)

Network: **Sepolia** (`chainId` **11155111**)

| Item | Value |
| --- | --- |
| Parent name | `ensure.eth` |
| Production name | `prod.ensure.eth` |
| Preview name | `preview.ensure.eth` |
| Project UserRegistry | `0x9A322BAc469a3d03185730e8eCF0035389206F8B` |
| Production PermissionedResolver | `0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7` |
| Preview PermissionedResolver | `0x75b4dCA2604585c81ce4E24c9879E1aBF1514Bcf` |
| Owner (MetaMask) | `0xBa3084737A99f3ccB2F384b3AE8f325CF50EfBBe` |
| Pinata gateway | `https://blush-legislative-impala-818.mypinata.cloud` |

Put these (and `releaseController: null` or `""` until deploy) in **`deployments/sepolia.json`**. The UI must **read addresses from that file** (import or fetch), not hardcode them in random components.

`ENSureReleaseController` lives at `contracts/src/ENSureReleaseController.sol` and is **not deployed yet**. Leave `releaseController` as a config field the UI can show as “not deployed”; disable Promote/Rollback/Recover that depend on it until the address is set. Until then, Owner Promote may fall back to a **direct owner multicall** on the production resolver (contenthash + text keys) so the MetaMask owner can restore a fresh approval.

## Critical ownership note

The owner reapproved release 4 successfully. The saved full-verifier result was GREEN after transaction `0x7c98c0a2ccbda38c4095e3c7d5c3bff8de17bfe6995c4b6f7300df9dc08da0ae` at block 12078131. This is historical evidence, not a live status or a real repository build. Older manifests were signed by a previous owner. The UI **must** let the connected MetaMask owner:

1. Build a new canonical manifest for a candidate CID,
2. Sign the EIP-712 approval,
3. Promote (multicall or controller when deployed),

so Verify can return MATCH again. Never fake a green result while the signature check fails.

## ENSv2 read pattern

Do **not** assume ENSv1 direct `contenthash(node)` on an arbitrary resolver. Follow the verified ENSv2 registry hierarchy as the tools do, then call the pinned PermissionedResolver `resolve(bytes,bytes)`. A Universal Resolver integration is optional and must use its own verified ABI and address.

Use:

1. DNS-encode the full name (e.g. `prod.ensure.eth`) the same way viem/ENS helpers do.
2. Call the verified PermissionedResolver: `resolve(bytes dnsName, bytes data)` where `data` is an ABI-encoded profile `contenthash(bytes32)` or `text(bytes32,string)` call.
3. Decode returned bytes. Treat RPC / empty / decode failures as **UNAVAILABLE**, not MATCH.
4. Do not substitute a generic Universal Resolver ABI or an unverified address.

## Text keys already used by ENSure scripts

From `tools/ensure-sepolia/scripts/config.ts` and related scripts:

| Key | Who writes | Meaning in current scripts |
| --- | --- | --- |
| `ensure.build` | CI on **preview** | Preview build metadata pointer (`ipfs://…`) |
| `ensure.manifest` | Owner on **prod** (and planned CI on preview in some docs) | Manifest CID pointer (`ipfs://…`) |
| `ensure.release` | Owner on **prod** | In the live script path this was also set to `ipfs://` + manifest CID (same pointer as manifest). The controller design instead sets it to a `0x` hex **release id**. Support both: if value looks like `ipfs://…` treat as manifest pointer; if `0x` + 64 hex treat as release id. |
| `ensure.approval` | Owner on **prod** | Canonical signed envelope inline; verify its raw-CID commitment before trusting it. |
| `ensure.policy` | Owner on **preview** | Human-readable policy string (not a CID) |

## EIP-712 manifest format (summarize and implement)

Implement the same shape as `tools/ensure-sepolia/scripts/ensure-manifest.ts`.

Compatibility boundary: this isolated live ENSv2 fixture envelope is **not** the `core/src/manifest.ts` build-file manifest or the controller release-id format. Reuse `core/` and `server/` APIs where appropriate, but never silently cast one manifest into the other. The existing setup script and server follow their existing protocol path; this change does not migrate them to the pinned ENSv2 deployment.

The current tools verify **raw SHA-256 CIDs for one small file**, not UnixFS directories. A directory frontend release needs a separately tested DAG/file-manifest verifier. Do not claim that capability by reusing the fixture verifier.

Envelope format:

- Envelope JSON (canonical / JCS): `{ "core": {…}, "signature": "0x…" }`
- `core` fields (all present):
  `schemaVersion` (1), `chainId`, `name`, `projectName`, `parentRegistry`, `registry`, `parentResource`, `resource`, `resolver`, `cid`, `commit`, `buildHash`, `release`, `approver`, `issuedAt`, `validUntil`, `previousManifest`
- Canonicalize with the same rules as the `canonicalize` / JCS path (no extra whitespace; sorted keys).
- `coreHash = keccak256(utf8Bytes(jcs(core)))`
- EIP-712 domain: `{ name: "ENSure", version: "1", chainId: 11155111 }`
- Types: `ReleaseApproval(bytes32 coreHash)`
- Primary type: `ReleaseApproval`
- Message: `{ coreHash }`
- Signature: 65-byte EOA signature from the **trusted owner** (`deployments.sepolia.json` owner). Recovered signer must equal that owner.

Verify must check: ENS contenthash CID ↔ `core.cid`, fetch manifest bytes, JCS round-trip, signature, optional file/bytes hash ↔ `buildHash`, expiry window.

## Pinata / IPFS fetch

The historical gateway `https://blush-legislative-impala-818.mypinata.cloud` refuses HTML (ERR_ID:00023). Make the gateway configurable; use localhost for the owner page, or a separately approved working custom-domain/static host. Gateway availability must never be confused with integrity.

Fetch:

- Manifest: `https://blush-legislative-impala-818.mypinata.cloud/ipfs/<manifestCid>`
- Site files: `…/ipfs/<siteCid>/<path>` (and fall back to `https://ipfs.io` / `https://dweb.link` if the dedicated gateway fails)

Hash raw `arrayBuffer` bytes (SHA-256 for file checks; keccak for `coreHash` as above). Never claim MATCH if fetch failed.

## Controller ABI surface (when address is set)

From `contracts/src/ENSureReleaseController.sol`:

- `promote(bytes contenthashBytes, string manifestCid, bytes32 manifestDigest, bytes32 commitDigest)`
- `rollback(bytes32 releaseId)`
- `recover(bytes32 releaseId, string reason)`
- views: `currentReleaseId()`, `getRelease(bytes32)`, `ownerSafe()`, `recoveryAuthority()`, `productionRegistry()`, `productionResolver()`

Before trusting controller writes, the contract itself checks `productionRegistry.getResolver("prod")` matches the configured production resolver.

## Pages to build

### `/` — Landing

- One-line pitch: ENS + sure — the name always serves the approved build.
- Links to Verify, Owner, Recover.
- Show network Sepolia + `ensure.eth` + link to fill `deployments/sepolia.json`.
- Honest limits: MATCH ≠ safe code; gateway availability; owner is root of trust.

### `/verify` — Public verifier (no wallet required)

- Input: ENS name (default `prod.ensure.eth`).
- Steps (show a checklist):
  1. Resolve contenthash + `ensure.manifest` + `ensure.release` + `ensure.approval` through the verified ENSv2 resolver.
  2. Confirm resolver / registry pointers against config where possible.
  3. Prefer canonical `ensure.approval` bytes if present and check their CID; otherwise fetch manifest by CID through a configurable gateway.
  4. Validate JCS + EIP-712 signature against configured owner.
  5. Compare CID / buildHash / file hashes; validate active ancestors, resources, implementation provenance, effective contenthash/text writer or admin authority, exclusive production writers, and a single block snapshot with a reorg guard.
- Result states only: **MATCH** | **MISMATCH** | **UNAVAILABLE**
  - Map any prior GREEN/RED/AMBER language to these three.
  - UNAVAILABLE for RPC/gateway/decode failures — **never** paint MATCH.
- Show expected vs observed, commit, CIDs, approver, release, and the exact failed check.
- Banner if signer ≠ configured MetaMask owner: explain that ownership moved and Owner must sign a fresh promote.

### `/owner` — MetaMask owner dashboard

- Connect MetaMask; require account `0xBa3084737A99f3ccB2F384b3AE8f325CF50EfBBe` (or the `owner` field from deployments) for privileged actions.
- Show roles / who can write preview vs prod (read `hasRootRoles` / `hasRoles` when possible).
- Preview vs prod diff (contenthash, text keys, CIDs).
- Buttons (all live txs, no mocks):
  - **Promote** — build/sign EIP-712 envelope, pin or accept CIDs, then multicall or `controller.promote`.
  - **Rollback** — select prior release; either controller.rollback or fresh-signed promote of prior CID (document which path is active).
  - **Revoke CI** — revoke preview contenthash + `ensure.build` (and any other CI text grants) on the preview resolver.
- Release history from local receipts / controller events / config history.
- Disable controller-only actions until `releaseController` is set.

### `/recover` — Recovery authority

- Connect wallet; only `recoveryAuthority` (from controller config when deployed) can submit.
- List approved releases; pick one; require non-empty reason; call `recover(releaseId, reason)`.
- If controller not deployed: show clear “not available yet” state (do not fake success).

### Optional Arkiv history panel

- Feature flag e.g. `VITE_ARKIV_HISTORY=1`.
- Read-only `@arkiv-network/sdk` `createPublicClient` query of release passport entities tagged for ENSure.
- Do not block MVP if Arkiv is unset. No write keys in the browser for Arkiv unless using the user’s wallet deliberately later.

## Folder structure (suggested)

```text
web/
  package.json
  vite.config.ts
  index.html
  src/
    main.tsx
    App.tsx
    pages/{Landing,Verify,Owner,Recover}.tsx
    lib/{ens.ts,manifest.ts,verify.ts,deployments.ts,ipfs.ts,controller.ts}
    components/{ChecksList,StatusBadge,ConnectButton,ReleaseTable}.tsx
  .env.example   # VITE_SEPOLIA_RPC_URL=, VITE_PINATA_GATEWAY=, VITE_ARKIV_HISTORY=0
```

Root `deployments/sepolia.json` remains the address book. Secrets only as **placeholders** in `.env.example` — never commit real keys or JWTs.

## Acceptance criteria

1. `pnpm --filter web dev` (or `npm run dev` in `web/`) serves all four routes.
2. `/verify` against `prod.ensure.eth` reads **live** Sepolia state and shows MATCH, MISMATCH, or UNAVAILABLE with a per-check list.
3. Fetch current chain state, never hardcode the saved GREEN result. An expired signature or unavailable gateway must not show MATCH.
4. Connected MetaMask owner can sign a fresh EIP-712 manifest and submit a promote tx (multicall or controller).
5. No hardcoded private keys; no simulated MATCH; failed fetches → UNAVAILABLE.
6. Addresses come from `deployments/sepolia.json`.
7. Typecheck clean; basic component tests optional but welcome.

## Do not

- Do not hardcode private keys, Pinata JWTs, or mnemonic phrases.
- Do not fake MATCH / green when any required check failed or was skipped.
- Do not read “cached demo JSON” instead of live chain + gateway fetches (fixtures only for unit tests).
- Do not rename the product away from ENSure.
- Do not add Swarm, World ID, AI scanners, or unrelated deploy-platform servers into `web/`.
- Do not block the whole app on Arkiv; keep it optional.

## Implementation order

1. Scaffold Vite React TS + Tailwind + wagmi/viem Sepolia.
2. `lib/ens.ts` + `lib/manifest.ts` + `lib/verify.ts` ported from existing ensure scripts/ideas.
3. `/verify` end-to-end on live name.
4. `/owner` MetaMask promote path to restore MATCH.
5. Revoke CI + history.
6. `/recover` gated on controller address.
7. Optional Arkiv panel behind flag.

When done, summarize routes, how to run, and any gaps (controller still undeployed, etc.).
