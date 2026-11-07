# ENSure web app

ENSure lets the current owner publish an approved static-site release through ENSv2 on Sepolia. Visitors can check the live ENS pointer, the current owner's EIP-712 signature, the build manifest and the files fetched from IPFS before they trust the site.

## Run locally

From the repository root:

```sh
pnpm install
cp web/.env.example web/.env.local
pnpm --filter web dev
```

The app opens at `http://localhost:5173`. It reads contract addresses and ENS names from `deployments/sepolia.json`. The Sepolia RPC URL and gateway overrides are public configuration values. The browser signs transactions through MetaMask; it never uses a private key, Pinata JWT or other service secret.

## Build and type-check

```sh
pnpm --filter web typecheck
pnpm --filter web build
pnpm --filter web preview
```

The static output is written to `web/dist/`. Vercel and Netlify are configured to route app paths back to the SPA entry point.

## Optional environment values

Copy `.env.example` to `.env.local` and set only values needed for your environment:

- `VITE_SEPOLIA_RPC_URL`: public Sepolia JSON-RPC endpoint. The app has public fallbacks.
- `VITE_PINATA_GATEWAY`: public Pinata gateway URL tried before public gateways.
- `VITE_IPFS_GATEWAYS`: comma-separated public gateway URLs tried after Pinata.
- `VITE_HISTORY_FROM_BLOCK`: optional earlier block for a fuller event-history scan. Without it, reads start at the last owner-promotion block recorded in the deployment config so the app does not scan Sepolia from genesis.
- `VITE_APP_BUILD_CID`: the IPFS CID for this frontend deployment, shown in the footer.

Do not add an API key, private key, Pinata JWT or other secret to a `VITE_` variable: Vite exposes these values to every browser user.

## Pages

- **Overview** reads production and preview records live and shows the current production verification status.
- **Verify release** is public and wallet-free. It checks the configured ENSv2 hierarchy, separated resolver addresses, current owner, production writer permissions, the EIP-712 approval, the site CID and every file declared in the canonical build manifest. It fetches the approval and build manifests from the configured Pinata gateway first, retries HTTP 429 responses, then falls back to public IPFS gateways. A gateway or RPC failure is `UNAVAILABLE`; it never counts as a match.
- **Promote** is owner-only. It verifies the preview files before asking the current ENS parent-name owner to sign. Promotion writes the contenthash, approval records and `ensure.build` pointer in one resolver multicall. It also grants or revokes only the CI wallet's preview resolver roles. Direct-owner rollback makes a new release and fresh owner signature; it does not reuse an old signature.
- **Release history** reads `TextUpdated` events from the production resolver and, if configured, events from the release controller. It does not use a hard-coded release list or a server history response.

## Current limitations

- A green result means the checked ENS records, owner signature, build metadata and fetched file hashes agree. It is not a code audit and does not prove that external scripts or stylesheets are safe.
- ENSure can only fully verify directory builds that publish a `core/src/manifest.ts` build manifest pointer in `ensure.build` (or the compatible preview `ensure.manifest` field). If production has no `ensure.build` pointer, the result is `UNAVAILABLE` rather than green.
- The current signed approval format binds the site CID, source commit and `index.html` SHA-256. The canonical build manifest is separately checked against the site CID and every declared file. Deploys should publish the build pointer with the approval so both records change atomically.
- The default event-history scan starts at the last owner-promotion block recorded in `deployments/sepolia.json` for speed. It may omit releases before that checkpoint; set `VITE_HISTORY_FROM_BLOCK` to an earlier known project block for a fuller timeline. This changes scan scope, not release truth.
