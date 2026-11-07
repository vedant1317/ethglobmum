# Arkiv integration progress

**Updated:** 2026-11-06
**Status:** module and smoke script implemented; live Rabdi create/query passed; typecheck and unit suite pass.
**Scope:** queryable release history and provenance for ENSure. Arkiv is evidence/discovery only. ENSv2 and `ENSureReleaseController` remain authoritative for production state.

This is the working log for the Arkiv module. Update the status, decisions, blockers, and checklist after each implementation step.

## 1. Where Arkiv fits

ENSure already has a release evidence pipeline:

1. `core/src/manifest.ts` makes a canonical manifest and computes `manifestDigest` and `commitDigest`.
2. `core/src/pipeline.ts` pins the site and manifest to IPFS and returns their CIDs, digests, and ENS contenthash.
3. `server/src/deploys.ts` publishes protected releases to `preview.<project>.eth`; this is the natural source for a `CANDIDATE` Arkiv event.
4. `contracts/src/ENSureReleaseController.sol` is the production authority. A confirmed `ReleasePromoted`, `ReleaseRolledBack`, or `ReleaseRecovered` event is the source for the matching Arkiv event.
5. A future Release Explorer (web app does not exist in this checkout) queries Arkiv and independently checks production claims against the controller and IPFS manifest.

Arkiv writes must be best-effort for deployment and approval: an Arkiv RPC error must not fail a preview deploy, undo an ENS transaction, or change what is considered live. Never infer current production from Arkiv history.

## 2. Dependency map

### Upstream inputs Arkiv consumes

| Source | Existing contract/data | Needed by Arkiv | Current state |
| --- | --- | --- | --- |
| Project identity | `projects.name`, GitHub repo ID; project node is `namehash(project ENS name)` | Canonical `projectNode` for query partitioning | Repo and name exist; no Arkiv linkage yet |
| Build and manifest | `Manifest` from `core/src/manifest.ts`: commit SHA, repo ID/URL, build run URL, site CID, file hashes | Manifest CID, manifest digest, commit digest, site CID and commit SHA for candidate | Implemented in core |
| Pinata | `pinRelease()` result and fetch-back | Only write after both artifacts are pinned and fetch-back succeeded | Implemented; README says live Pinata has not been run |
| Preview publication | `publishName()` returns a confirmed Sepolia tx hash | Candidate evidence should be emitted only after the preview write succeeds | Implemented for deploy path |
| Release controller | `projectNode()`, `ownerSafe()`, `getRelease(bytes32)`, `currentReleaseId()`, `ReleasePromoted`, `ReleaseRolledBack`, `ReleaseRecovered` | Verify source contract/receipt, extract release IDs, match stored digest/CID/commit evidence | Contract source and unit tests exist; deployment address/configuration is absent |
| Arkiv operator | Dedicated EVM writer wallet, Rabdi access key, tGLM, SDK | Sign Arkiv writes and query the public network | SDK installed; wallet/access key/funding still manual |

### Downstream consumers and integration points

| Consumer | Data/API it needs | Integration status |
| --- | --- | --- |
| Server deploy worker | `recordReleaseEvent(...)` after successful protected preview publish | Hook implemented as best-effort; live write not yet exercised |
| Promotion/rollback recorder | Confirmed Sepolia tx hash, expected controller address and project; verify receipt/event before writing Arkiv | Authenticated API callback and chain validation added; no live controller tx exercised |
| Release Explorer and project page | `getReleaseHistory(projectNode, filters)`, `getReleaseEvents(projectNode, releaseId)`; typed display items and verification state | Query API exists; `web/` has no app implementation yet |
| CLI / reconciliation script | Re-read controller logs and repair missing Arkiv evidence | Optional for first usable integration; required for restart/replay reliability |
| Hackathon evidence | Schema/query documentation, reproducible query, writer address, expiry and real UI query | Not started |

### Manual handoffs needed from the ENS/controller owner

The contract source already provides most of the interface, so no raw personal signature or private key is needed from the ENS owner by the Arkiv module. The integration needs:

- The deployed Sepolia controller address for each protected project and the expected project ENS name/namehash.
- Confirmation that `ensure.controller` points to that same controller, and the production resolver/registry setup is complete.
- The deployed controller ABI/artifact (or agreement to derive it from this repo's Solidity build), plus the controller deployment block for event replay.
- The transaction hash after an owner/Safe calls `promote`, `rollback`, or recovery calls `recover`. For Safe flows, provide the executed on-chain transaction hash, not the Safe proposal hash.
- The confirmed receipt/logs or a rule for how many Sepolia confirmations count as final for the demo.
- Confirmation that the event field meanings remain: `releaseId` is the release selected/restored; `previousReleaseId` on promotion and `fromReleaseId` on rollback/recovery is the release active immediately before the action.

The writer will independently fetch the receipt and logs from Sepolia. It must reject failed receipts, wrong chain IDs, wrong controller addresses, and a log whose project/release evidence does not match `getRelease(releaseId)` and the fetched canonical manifest. Do not trust a transaction hash or event fields supplied by the browser alone.

## 3. Proposed Arkiv schema (`ensure.release-events.v1`)

Use the TypeScript SDK schema API and keep large evidence in IPFS. Every event is append-only by application convention. Arkiv `readonly` and an entity key are useful protections, but do not make records undeletable or permanent.

| Attribute | Arkiv type | Indexed | Purpose |
| --- | --- | --- | --- |
| `projectNode` | `str` | yes | ENS namehash (`0x` plus 64 hex chars); project partition and lookup |
| `eventId` | `str` | yes | Deterministic idempotency key |
| `eventType` | `str` | yes | `CANDIDATE`, `PROMOTED`, `ROLLBACK`, or `RECOVERED` |
| `releaseId` | `str`, optional | yes | Controller release ID; absent on an unapproved candidate |
| `fromReleaseId` | `str`, optional | no | Previously active ID for promotion/rollback/recovery |
| `commitSha` | `str` | yes | Full lowercase Git SHA; search/filter key |
| `manifestCid` | `str` | no | Canonical manifest reference |
| `manifestDigest` | `str` | no | `0x` + 32-byte keccak digest |
| `siteCid` | `str` | no | IPFS site directory reference |
| `commitDigest` | `str` | no | Controller's `keccak256(commitSha)` value |
| `sourceTx` | `str`, optional | no | Sepolia preview or controller transaction hash |
| `sourceContract` | `str`, optional | no | Expected controller address for controller events |
| `sourceChain` | `u64` | no | Source chain ID; currently Sepolia `11155111` |
| `sourceBlock` | `u64`, optional | no | Confirmed source transaction block |
| `sourceLogIndex` | `u64`, optional | no | Controller event index; absent for candidate transactions |
| `recordedAt` | `u64` | no | Unix seconds for UI sorting/display |

This uses 16 application columns, within the guide's stated 31-column ceiling. Validate every string's UTF-8 byte length and the actual CID encoding before writing; do not assume every valid CID fits Arkiv `str`. Keep the named schema unique to ENSure. Query by indexed attributes only: project, event type, release ID, commit SHA, and event ID. Filter results to the configured writer as well as the named schema.

**Event meanings:**

- `CANDIDATE`: generated after a protected preview release has been pinned, verified, and successfully published. It carries no `releaseId` and is never approval.
- `PROMOTED`: emitted only after a confirmed controller event. `releaseId` is the newly approved release; `fromReleaseId` is the previous current release.
- `ROLLBACK`: emitted after confirmed `ReleaseRolledBack`; `releaseId` is the restored release and `fromReleaseId` is the release rolled back from.
- `RECOVERED`: emitted after confirmed `ReleaseRecovered`; same release-ID meaning as rollback, plus recovery is distinguishable in the history.

Event IDs should be deterministic. For controller events, derive from chain ID, controller address, transaction hash, and log index. For candidate events, derive from the ENSure project ID, deploy ID, and commit SHA. Before retrying, query for that event ID; this avoids common duplicate retries but is not an atomic uniqueness guarantee.

## 4. What the frontend receives

Reader functions return normalized, UI-ready release evidence rather than raw SDK entities. The UI verification layer adds `verification` and `verificationDetails` only after checking controller and manifest data; the Arkiv row by itself starts as unverified. Minimum combined view:

```ts
type ReleaseHistoryItem = {
  entityKey: string;
  eventId: string;
  eventType: "CANDIDATE" | "PROMOTED" | "ROLLBACK" | "RECOVERED";
  projectNode: string;
  releaseId?: string;
  fromReleaseId?: string;
  commitSha: string;
  siteCid: string;
  manifestCid: string;
  manifestDigest: string;
  sourceTx?: string;
  sourceChain: number;
  sourceBlock?: number;
  recordedAt: number;
  expiresAt: number;
  writerAddress: string;
  verification: "VERIFIED" | "UNVERIFIED" | "UNAVAILABLE";
  verificationDetails: string[];
};
```

The explorer needs project history, filter-by-event-type, filter/search-by-commit or release ID, pagination, and detail links to IPFS and Sepolia transactions. A verified promotion must match the confirmed controller log and `getRelease` fields, then match the IPFS manifest digest, commit digest and site CID. Candidates are explicitly labeled **not approved**. If Arkiv is unavailable or an entity expired, show history unavailable/incomplete; keep current-production status sourced from the controller and ENS records.

The writer client/private key stays in the server or a protected operator script. Frontend uses a read-only Arkiv public client. Never expose `ARKIV_PRIVATE_KEY` to Vite/browser code.

## 5. Repository placement and implementation order

The pasted guide's `packages/arkiv` layout does not match this repo's pnpm workspace (`core`, `server`, `cli`, `site`). Prefer a workspace package at `arkiv/` (add it to `pnpm-workspace.yaml`) with `src/schema.ts`, `client.ts`, `validate.ts`, `write.ts`, `query.ts`, and `index.ts`. Server imports writer functions; future web imports only browser-safe schema/query exports. Keep the SDK out of `core` until browser bundling and runtime boundaries are confirmed.

| Step | Work | Exit condition | Status |
| --- | --- | --- | --- |
| 0 | Manual Rabdi account, access key and funded test wallet; SDK smoke create/query | Record one test entity and query it back; record entity key/tx | Passed: chain 7794095, writer matched, 10 tGLM, entity created and queried |
| 1 | Add SDK/workspace package; define schema and validators | Types align with installed SDK; malformed fields rejected | Implemented; root typecheck passes |
| 2 | Read/write clients, deterministic event IDs, duplicate lookup, expiry and safe error mapping | Server-side write and public query work on Rabdi | Smoke create/query passed on Rabdi |
| 3 | Record candidate from successful protected preview deploy | Real manifest receipt appears in query; failure does not fail deploy | Hook implemented; live protected deploy not exercised |
| 4 | Validate and record controller promotion, rollback and recovery logs | Wrong chain/contract/receipt rejected; real event links to stored release | Code added; needs a real executed tx for live confirmation |
| 5 | History query, filters and pagination; trusted-writer filtering | Reproducible project/commit/release queries return typed results | Not started |
| 6 | Add replay/reconciliation for missed controller events and retention handling | Re-running sync is idempotent; incomplete/expired evidence is represented accurately | Not started |
| 7 | Integrate Release Explorer and document sponsor evidence | UI visibly reads Arkiv and cross-checks controller state | Not started |

## 6. Manual setup checklist

1. Create a dedicated EVM wallet for Arkiv testnet writes. Do not reuse the ENS owner Safe, recovery wallet, deployer, or server publisher wallet.
2. Get Rabdi tGLM from the Arkiv faucet and an access key from the Arkiv Hub. Rabdi is separate from Sepolia (chain ID `7794095`, native token tGLM).
3. Store the access key and private key in local ignored `.env`/secret storage. Server variables are `ARKIV_ACCESS_KEY`, `ARKIV_PRIVATE_KEY`, `ARKIV_WRITER_ADDRESS`, `ARKIV_RETENTION_DAYS`, and `ARKIV_SOURCE_CONFIRMATIONS`. Never commit them or expose the private key to the browser.
4. Provide the controller/project deployment data listed in Section 2. Confirm a real Sepolia promotion/rollback/recovery transaction is available for integration.
5. Decide the public writer address to publish in the Arkiv README/evidence docs. The address is public; its private key is not.

## 7. Current decisions and open checks

- **Authority:** ENSv2/controller, never Arkiv.
- **Network:** Arkiv Rabdi for the current testnet integration; Sepolia remains the source chain for ENS/controller events.
- **SDK:** `@arkiv-network/sdk` with the TypeScript schema/query APIs and viem-based chain clients.
- **Retention:** use a configurable demo value (90 days is the initial proposal); expose exact `$expiresAt` from the entity response. Plan renewal or external archival before claiming long-term history.
- **Writer:** one dedicated project writer; reads filter by named schema and trusted writer.
- **Candidate timing:** after successful preview publish/read-back, not merely after a build or Pinata upload.
- **Promotion timing:** only after the source transaction is confirmed and its expected controller event/release fields are verified.
- **Checked against installed SDK 1.0.1:** create return includes entity key, tx hash and expiry block; `createdBy` exists; schema names tag entities; `readonly` is a creation flag; strings cap at 128 UTF-8 bytes; query pages cap at 100. Live Rabdi behavior, exact expiry policy, and pagination under concurrent writes remain to verify.
- **Current code boundary:** `arkiv/` has schema, validation, public/wallet clients, write/query functions, and a Sepolia controller transaction validator. Server records protected preview candidates after the ENS write; authenticated `/projects/:id/arkiv-events` records controller events after validation. Reconciliation and UI integration remain.
- **2026-11-06 live Rabdi smoke:** `pnpm arkiv:smoke` passed. Chain ID `7794095`; derived writer matched configured address `0xA28c55Fa90e4dA2F3Ad7dd829D6A722948436fBa`; balance `10 tGLM`; public query found the one-day `ensure.arkiv-smoke.v1` entity. Transaction: [`0x11abd08b23d169ae17059341d32b8370f9a678e5f4213f0dd2f6818f6028c3e6`](https://rabdi.explorer.arkiv.network/tx/0x11abd08b23d169ae17059341d32b8370f9a678e5f4213f0dd2f6818f6028c3e6). Entity key: `0xbf811f2bff37c3182bf9b0e3f8a4e5aa25c626c1055ab2e37e50137ba2ce0e23`. Expiry block: `344035`. No credentials were printed or modified.
- **2026-11-06 code verification:** `pnpm typecheck` passed. `pnpm test` passed (59 tests). `pnpm e2e` was not run because `anvil` and `forge` are unavailable. The smoke script and Arkiv writer client accept a 64-hex-character private key with or without its `0x` prefix; the local env value was left unchanged.
- **Temporary visual test page:** created for review at `http://127.0.0.1:4177`, successfully displayed the smoke entity, and was removed on user request. Its server script and `pnpm arkiv:ui` command are no longer present. The independent `pnpm arkiv:smoke` command remains.
- **UI dependency:** current repository has no web app implementation, so the Arkiv reader contract can be prepared first, but visible explorer integration depends on the web work being started.

## 8. Sources and project references

- [Rabdi network](https://docs.arkiv.network/networks/rabdi/)
- [Store and query your first entity](https://docs.arkiv.network/start-here/first-entity/)
- [Define a schema](https://docs.arkiv.network/schemas/define/)
- [Entity expiration](https://docs.arkiv.network/writing/expiration/)
- Project architecture: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Implementation order: [BUILD_SPEC.md](./BUILD_SPEC.md)
- TypeScript/tool choice: [TECH_AND_DEMO.md](./TECH_AND_DEMO.md)
- Controller source: [`ENSureReleaseController.sol`](../contracts/src/ENSureReleaseController.sol)
