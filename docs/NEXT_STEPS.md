# ENSure: completed work and next steps

Snapshot: 2026-11-06, IST. Base: main `02bf352`.

## Done

- ENSv2 Sepolia project `ensure.eth`, separate prod/preview resolvers; public addresses in `deployments/sepolia.json`.
- Owner `0xBa3084737A99f3ccB2F384b3AE8f325CF50EfBBe` approved fixture release 4. Promote transaction and historical GREEN evidence are saved in that deployment file and `tools/ensure-sepolia/evidence/owner-promote-result.sepolia.json`.
- Full verifier checks configured-owner EIP-712 signature and effective resolver contenthash/text write or admin roles. Environment-token holder is informational; hierarchy, active registrations, resource versions, provenance, exclusive writers, and block consistency remain required.
- MetaMask signing page source + reproducible build; no wallet keys or API tokens in browser code.
- Root `.env.example` retains every existing key. `setup-server.sh` generates a private local environment and prompts before one-time Sepolia setup transactions.

Historical GREEN is not a guarantee of current availability or approval validity. The signed artifact is a test fixture, not a real GitHub build, and approval expires.

## Next, in order

1. Review the exact diff and test results before publication or integration. Do not modify another developer's branch or working changes.
2. Build `web/` using `docs/CODEX_FRONTEND_PROMPT.md`: Vite, React, TypeScript, Tailwind, viem, wagmi, TanStack Query. Keep the optional Arkiv history adapter behind a feature flag; confirm the current official TS SDK release before installing it.
3. Implement public Verify first; map GREEN/RED/AMBER to MATCH/MISMATCH/UNAVAILABLE. No wallet needed; no cached/demo GREEN.
4. Add owner preview review, explicit MetaMask signature + transaction, history, rollback, and preview-only CI revocation. Disable controller-only recovery until deployment is configured.
5. Agree a real build manifest format. `core/src/manifest.ts`, the ENSv2 fixture envelope, and the controller release-id scheme differ. Add tested adapters rather than silently mixing them; implement UnixFS directory verification before claiming real frontend-build byte verification.
6. One team member runs platform onboarding using a name the setup wallet already owns; share only `PLATFORM_NAME`, `PLATFORM_REGISTRY`, `PLATFORM_RESOLVER`. These are not the isolated ENSv2 project resolver values. Each developer keeps their own session secret, test wallet, and Pinata token.
7. Add environment-protected CI: build untrusted source without secrets; pin and update preview in a separate constrained job. Owner/recovery keys never enter CI. Shared Actions secrets require separate approval.
8. Finish controller tests (the current test file is a stub), deploy only with approval, and prove writer-role isolation. Granting controller roles changes the verifier's exclusive-writer assumptions; update both deliberately with tests.
9. Record a real build publish → preview → approve → verify → tamper → revoke → rollback/recover drill. Document precisely what the evidence proves.

## Hosting and limits

The historical default Pinata subdomain cannot serve HTML (ERR_ID:00023). Serve the signing page on localhost, or use a custom domain/static host only after publication approval. Public gateways may be unavailable or rate-limited; report UNAVAILABLE, never MATCH.

This branch does not implement a frontend, CI release workflow, controller deployment, server protocol migration, or full UnixFS verifier. No transactions or uploads are executed by installing or testing it.
