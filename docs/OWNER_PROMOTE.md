# Owner approval on Sepolia

## Confirmed historical result

The owner submitted transaction `0x7c98c0a2ccbda38c4095e3c7d5c3bff8de17bfe6995c4b6f7300df9dc08da0ae` in block **12078131**, using **3831195** gas. The independent full verifier reported **GREEN, release 4**, at block 12078134 on 2026-11-06 at 23:18 IST. Public evidence: `tools/ensure-sepolia/evidence/owner-promote-result.sepolia.json` and `deployments/sepolia.json`.

This proves approval of the small fixture bytes, not safe code or a real repository build. It is not a promise that verification will stay GREEN: signatures expire and current state must be read again.

## Commands (repo root)

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm verify:sepolia prod                 # public read-only RPC; no wallet key
pnpm owner:build                         # deterministic offline build from saved public snapshot
pnpm owner:prepare                       # read-only current Sepolia snapshot + call/gas simulation
pnpm owner:publish                       # dry run: no credential read or upload
# Only after explicit approval to publish this exact public HTML:
pnpm owner:publish --publish
python3 -m http.server 18777 --bind 127.0.0.1 --directory tools/ensure-sepolia/owner-promote
```

Source: `tools/ensure-sepolia/scripts/owner-promote-browser.ts` and `owner-promote-template.html`. Build/data: `tools/ensure-sepolia/owner-promote/index.html` and `release-data.json`. `owner:build` never signs, sends, or uploads. `owner:prepare` refreshes public data and rebuilds, but never signs or sends. `SEPOLIA_RPC_URL` overrides the free public read endpoint; never embed a private API-key URL into a publicly shared page.

The committed snapshot prepared release 4 **before** the transaction above. It is archival, not a new release request. Its stale-record guard refuses to overwrite the now-changed live manifest. Do not repeat the original approval: prepare a new page only when the owner explicitly requests a new release. Rebuilding changes source instructions, so the committed build is not claimed to be byte-identical to the previously published IPFS file.

## User actions, only when a new promote is wanted

1. Review the proposed artifact CID, hash, release number, configured owner, and resolver.
2. Connect MetaMask as `0xBa3084737A99f3ccB2F384b3AE8f325CF50EfBBe` on chain **11155111**.
3. Sign ENSure / version 1 / `ReleaseApproval(coreHash)` typed data; fresh chain timestamp, 48-hour expiry. Signing costs no gas.
4. Confirm one zero-value multicall to resolver `0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7`. The page simulates and estimates gas; it never automatically retries a transaction.
5. Inspect the receipt link and run the full independent verifier. Browser checks are supplementary only, not authoritative GREEN.

The page never asks for a private key, recovery phrase, Pinata token, or password. Reload protection uses localStorage for the prepared release when available.

## Envelope storage and authority

One resolver multicall updates unchanged contenthash plus three exact text keys:

- `ensure.release` and `ensure.manifest`: identical `ipfs://<raw-CID>` commitments.
- `ensure.approval`: canonical signed JSON envelope. Its raw SHA-256 CID must equal both pointers before signature validation.

The inline envelope is not claimed to be publicly IPFS-pinned. A stale nonempty inline value is rejected, not silently bypassed. Legacy empty inline approvals use the local raw-CID store; the known public fixture is bundled for independent checking. Unknown unavailable bytes return AMBER.

Project ownership is still strict. The environment token holder is informational, but the configured project owner must sign and hold effective contenthash and every required text-key write/admin role. Ancestors, expiry, resources, routing, pinned implementation provenance, production isolation, signed context, release checkpoint, CID/hash bytes, and snapshot/reorg checks remain enforced. No emancipation or ownership change is performed.

## Publishing

`owner:publish` uploads only `index.html`, not a directory. It uses server-side `PINATA_JWT` only after `--publish`, suppresses raw API errors, and checks gateway bytes. An ambiguous upload failure requires account inspection, never an automatic retry. No publishing has been performed by preparing this branch.

The historical `*.mypinata.cloud` gateway rejects HTML (ERR_ID:00023). Prefer localhost. For approved public hosting, configure `PINATA_GATEWAY` to a working custom domain or public gateway, remembering availability is separate from integrity.

## Compatibility boundary

These tools isolate the existing ENSv2 raw-file fixture schema under `tools/ensure-sepolia/`; they do not replace `core/src/manifest.ts`, server routes, or the controller release-id model. The server setup script continues to call the existing `pnpm setup-ens` path. Test adapters and directory-DAG verification are required before a real build pipeline or frontend can claim equivalent verification.
