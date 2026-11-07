# ENSure frontend plan

## Product in one sentence

ENSure publishes a static website to IPFS, uses an ENSv2 name to identify the release its owner approved, and lets anyone check that the name, approval, and fetched site files still agree.

The UI must describe a matching release as **verified**, never as safe. A match only says the observed release agrees with the approval rules and bytes that ENSure can check.

## Frontend shape

Build a static Vite + React + strict TypeScript application in `web/`. Use Tailwind and shadcn/ui-style primitives for a restrained zinc dark theme, `framer-motion` for the release-flow diagram and verifier checklist transitions, React Router for pages, TanStack Query for live reads, viem for ENSv2 reads and typed-data verification, and wagmi/injected wallets for owner actions.

All chain reads are Sepolia-only (`11155111`). The app imports `deployments/sepolia.json` for the project names, resolver/registry addresses, owner, CI address, controller address, and release checkpoint. RPC comes from `VITE_SEPOLIA_RPC_URL`, with a public Sepolia fallback. No browser code receives server secrets.

## Page data and sources

| Page | Data shown | Source and reuse |
| --- | --- | --- |
| Connect / app shell | Connected wallet, actual chain, ENSure project identity | wagmi injected connector; `deployments/sepolia.json`; require/switch to Sepolia before writes |
| Dashboard (`/`) | Live prod and preview resolver, contenthash/CID, ENS text records, manifest/approval fields, current verification state, latest known transaction and timestamp when discoverable | `core/src/ens.ts`: `findResolver`, `readContenthash`, `readText`, `decodeContenthash`, `sameCid`; verify files using browser-safe adapters around `core/src/manifest.ts`; optional authenticated history via `core/src/api.ts` types and `/projects/:id/deploys` |
| Verify (`/verify`, public) | Base ENS name (default `ensure.eth`), live prod and preview contenthash/build records, each integrity check, expected/observed values, CID/file checks, approver/expiry, final MATCH / MISMATCH / UNAVAILABLE | Read both child names directly through ENSv2/viem. Reuse the same signature and context rules as `tools/ensure-sepolia/scripts/verify.ts`; reuse `release-approval.ts` typed-data logic and `core/src/manifest.ts` for per-file manifest checks. Verify must not use the API to decide integrity. |
| Owner controls (`/promote`) | Current project owner, live preview candidate, free EIP-712 signature, promotion tx, preview-only CI role grant/revoke, rollback action and tx receipts | Read the current parent-name owner from ENSv2; enable actions only for that wallet on Sepolia. Reuse EIP-712 shape/domain and `owner-promote-shared.ts` calldata. EAC `grantRootRoles`/`revokeRootRoles` plus resource-scoped `grantRoles`/`revokeRoles` apply only to the preview resolver. Rollback either calls the configured controller or creates a fresh owner approval for a previously approved artifact when direct-owner mode is active. |
| Releases (`/releases`) | Newest-first event-derived releases, CID, manifest CID, commit, approver, block/time, transaction and rollback action | Read controller events when configured and `TextUpdated` events for `ensure.approval` from the production resolver. Do not use a hardcoded release list or an API receipt as the source of release history. If no events are available, show the real empty state. |

## Reusable code

- `@ensure/core/ens`: Sepolia protocol constants and ABIs, DNS encoding, ENSIP-7 contenthash encode/decode, contenthash/text reads through the existing ENSv2 Universal Resolver integration, resolver lookup, owner lookup, role constants, and publish-call construction.
- `@ensure/core/manifest`: canonical core build manifest parsing, canonical bytes/digests, file SHA-256 entries, and commit digest. This is the deploy pipeline's file-tree manifest; it is not interchangeable with the separate signed EIP-712 approval envelope.
- `@ensure/core/api`: `Deploy`, `Project`, `Receipt`, and deploy status types for optional authenticated history.
- `tools/ensure-sepolia/scripts/release-approval.ts`: canonical signed-envelope and EIP-712 type/domain shape.
- `tools/ensure-sepolia/scripts/owner-promote-shared.ts`: inline approval commitment, contenthash encoding, and resolver multicall construction. Do not import the frozen generated owner-promote page or its fixture as live project data.
- `tools/ensure-sepolia/scripts/verify.ts`: verification rules and result semantics. It imports Node-only configuration/client modules, so the browser needs a small browser-safe adapter in `web/`; do not change the existing verifier or core/server/contracts behavior.

## Known gaps and constraints

1. `web/` is empty. The pnpm workspace currently omits it; add it and update the lockfile for the frontend dependencies.
2. There is no `core/src/verify.ts`, despite the build spec describing one. The existing Sepolia verifier is under `tools/ensure-sepolia/scripts/verify.ts` and is coupled to Node-only config/client code. The frontend must port/adapt its checks without importing Node-only modules or silently changing the protocol.
3. `deployments/sepolia.json` has `releaseController: null` and an empty `history`. The UI must treat controller-only rollback/history as unavailable until a live address is configured. The current owner-promotion route can only use a direct resolver multicall if the connected owner has the required live roles.
4. `core/src/manifest.ts` describes a directory release with per-file hashes. The EIP-712 approval tools describe a separate envelope with a raw-CID artifact hash for a small fixture. These formats are not equivalent. The frontend must label the exact checks it performed and must not claim full directory-byte verification if a gateway, manifest, or per-file fetch is unavailable.
5. The server routes for projects and deploy history require a user session. Verify must work without that session and must never use server-provided status as integrity evidence.
6. Public gateway availability is not guaranteed. A failed RPC, resolver decode, manifest fetch, or file fetch is UNAVAILABLE, not MATCH. The configured Pinata gateway is a value from the deployment config and remains replaceable through a Vite setting.
7. The requested dashboard asks for release number, approver, timestamp, and transaction. Current ENS records do not always contain all four (legacy `ensure.release` may be a manifest pointer). Show a controller release ID or a server/on-chain receipt when actually available; otherwise show the field as unavailable/legacy rather than infer a value.
8. ENSv2 release resolver events are record-bundle events (`TextUpdated`/`ContenthashUpdated`) keyed by record ID, not the old per-name resolver events. Release history must filter the production resolver's `ensure.approval` changes and decode only canonical signed envelopes; check the official ENSv2 indexing documentation before assuming event layouts.
9. The app footer build CID is supplied only by `VITE_APP_BUILD_CID`; if unset, show “not provided”.

## Build order

1. Add `web/` to pnpm workspaces, scaffold strict Vite/React/TypeScript and configure Tailwind, shadcn-style primitives, wagmi/viem, React Router, TanStack Query, and Framer Motion.
2. Implement the deployment-config loader, Sepolia-only public client, wallet/network shell, and reusable ENS record reader.
3. Implement the browser-safe verifier and build the public Verify page first; make failures and unavailable dependencies visible.
4. Build the dashboard and releases view from live records and ENSv2 resolver/controller events.
5. Implement owner controls against the current on-chain project owner: preview-only CI role delegation, promotion from actual preview state, and rollback to an event-derived approved release; re-read chain state after each transaction.
6. Add responsive empty/loading/error states, static-host SPA fallback, `web/README.md`, and `web/.env.example`.
7. Run the requested web build/typecheck and existing repository tests; leave all changes uncommitted and unpushed.
