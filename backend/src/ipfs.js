/**
 * src/ipfs.js
 * IPFS upload via local Kubo daemon (HTTP API).
 */

const axios    = require("axios");
const FormData = require("form-data");
const fs       = require("fs");
const path     = require("path");

// Never published, at any depth. Matches the pipeline rule in docs (section 5, step 4).
const SKIP_DIRS = new Set([".git", "node_modules"]);
const REFUSE_FILE = [
  /^\.env(\..*)?$/i,          // .env, .env.local, .env.production
  /\.pem$/i, /\.key$/i,
  /^\.npmrc$/i, /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
];
const KEY_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AUTHORIZATION: basic [A-Za-z0-9+/=]{20,}|\bgh[pousr]_[A-Za-z0-9]{36}\b/;

function collectFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to publish a symlink: ${path.relative(baseDir, full)}`);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectFiles(full, baseDir));
    } else if (entry.isFile()) {
      const relative = path.relative(baseDir, full).replace(/\\/g, "/");
      if (REFUSE_FILE.some((re) => re.test(entry.name))) {
        throw new Error(`Refusing to publish ${relative}: it looks like a secret. Remove it from the build output.`);
      }
      results.push({ full, relative });
    }
  }
  return results;
}

/** Last line of defence: no file may contain a private key or an auth header. */
function assertNoSecrets(files) {
  for (const { full, relative } of files) {
    if (fs.statSync(full).size > 5 * 1024 * 1024) continue;
    if (KEY_CONTENT.test(fs.readFileSync(full, "latin1"))) {
      throw new Error(`Refusing to publish ${relative}: it contains a private key or credential.`);
    }
  }
}

/**
 * Upload a local directory to IPFS via the local Kubo daemon, as ONE directory.
 * Returns the CIDv1 of that directory (whose entries are the site's files).
 */
async function uploadDir(dirPath, name, log = console.log) {
  const files = collectFiles(dirPath);
  if (!files.some((f) => f.relative === "index.html")) throw new Error("Build output has no index.html at its root");
  assertNoSecrets(files);
  log(`  📁 Uploading ${files.length} files as "${name}"`);

  const kuboUrl = process.env.IPFS_API_URL || "http://127.0.0.1:5001";
  log(`  🖥️  Uploading to Kubo at ${kuboUrl}...`);

  const uploadForm = new FormData();
  for (const { full, relative } of files) {
    uploadForm.append("file", fs.createReadStream(full), { filename: relative });
  }

  // wrap-with-directory: Kubo returns one extra entry with an empty Name, the directory holding every file.
  const kuboRes = await axios.post(
    `${kuboUrl}/api/v0/add?cid-version=1&wrap-with-directory=true&pin=true`,
    uploadForm,
    {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: uploadForm.getHeaders(),
      timeout: 60000,
      responseType: "text",
    }
  );

  const entries = String(kuboRes.data).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const root = entries.find((e) => e.Name === "");
  if (!root) throw new Error("Kubo did not return a wrapping directory CID");
  log(`  ✅ Uploaded: ${root.Hash}`);
  return root.Hash;
}

/**
 * Warm up public IPFS gateways so the CID propagates quickly.
 */
async function warmGateways(cid, log = console.log) {
  const gateways = ["ipfs.io", "w3s.link", "nftstorage.link"];
  log(`  🔥 Warming ${gateways.length} gateways for CID ${cid}...`);
  await Promise.allSettled(
    gateways.map((host) =>
      axios
        .get(`https://${host}/ipfs/${cid}/`, { timeout: 12000 })
        .catch(() => {})
    )
  );
}

module.exports = { uploadDir, warmGateways, collectFiles, assertNoSecrets };
