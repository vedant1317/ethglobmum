#!/usr/bin/env tsx
/**
 * GitHub Actions entrypoint: pin site/dist via pinRelease, then set preview.ensure.eth
 * (contenthash + ensure.build) with the CI key. Never touches production.
 *
 * Env: PINATA_JWT, CI_PRIVATE_KEY, SEPOLIA_RPC_URL
 * Optional: PINATA_API_URL, PINATA_UPLOADS_URL, IPFS_GATEWAYS, IPFS_RETRY_MS,
 *           ENSURE_PREVIEW_NAME (default preview.ensure.eth)
 */
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pinRelease } from "@ensure/core/pipeline";
import { publishPreview } from "../tools/ensure-sepolia/scripts/preview-publish.js";

const siteDir = resolve("site/dist");
const commitSha = (process.env.GITHUB_SHA ?? process.env.COMMIT_SHA ?? "").toLowerCase();
const repository = process.env.GITHUB_REPOSITORY ?? "local/ensure";
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "local";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/.test(commitSha)) fail("Set GITHUB_SHA (or COMMIT_SHA) to a 40-char lowercase hex commit");
if (!process.env.PINATA_JWT) fail("PINATA_JWT is required");
if (!process.env.CI_PRIVATE_KEY) fail("CI_PRIVATE_KEY is required");
if (!process.env.SEPOLIA_RPC_URL) fail("SEPOLIA_RPC_URL is required (public Sepolia RPC; prefer a repo variable)");
if (!existsSync(resolve(siteDir, "index.html"))) fail(`Missing ${siteDir}/index.html (run: pnpm --filter @ensure/site build)`);

const log = (line: string) => console.log(line);
const gateways = process.env.IPFS_GATEWAYS?.split(",").map((s) => s.trim()).filter(Boolean);

const pinned = await pinRelease(
  {
    jwt: process.env.PINATA_JWT,
    apiUrl: process.env.PINATA_API_URL,
    uploadsUrl: process.env.PINATA_UPLOADS_URL,
    gateways,
    retryMs: process.env.IPFS_RETRY_MS ? Number(process.env.IPFS_RETRY_MS) : undefined,
  },
  {
    dir: siteDir,
    commitSha,
    repositoryId: process.env.GITHUB_REPOSITORY_ID ?? "0",
    repositoryUrl: `https://github.com/${repository}`,
    runUrl,
    buildTools: { node: process.version },
    label: `preview-${commitSha.slice(0, 8)}`,
  },
  log,
);

const receipt = {
  commitSha,
  siteCid: pinned.siteCid,
  manifestCid: pinned.manifestCid,
  manifestDigest: pinned.manifestDigest,
  commitDigest: pinned.commitDigest,
  contenthash: pinned.contenthash,
  name: process.env.ENSURE_PREVIEW_NAME ?? "preview.ensure.eth",
};
writeFileSync("receipt.json", JSON.stringify(receipt, null, 2) + "\n");
log(`Wrote receipt.json (site=${pinned.siteCid} manifest=${pinned.manifestCid})`);

const published = await publishPreview({
  siteCid: pinned.siteCid,
  manifestCid: pinned.manifestCid,
  expectedContenthash: pinned.contenthash,
});

const summary = {
  ...receipt,
  txHash: published.hash,
  explorer: published.explorer,
  blockNumber: published.receipt.blockNumber.toString(),
};
writeFileSync("receipt.json", JSON.stringify(summary, null, 2) + "\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## ENSure preview publish",
      "",
      `- Commit: \`${commitSha}\``,
      `- Site CID: \`${pinned.siteCid}\``,
      `- Manifest CID: \`${pinned.manifestCid}\``,
      `- Contenthash: \`${pinned.contenthash}\``,
      `- Transaction: [${published.hash}](${published.explorer})`,
      `- Block: ${published.receipt.blockNumber.toString()}`,
      "",
    ].join("\n"),
  );
}

console.log(JSON.stringify(summary, null, 2));
