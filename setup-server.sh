#!/usr/bin/env bash
# Run from the ENSure repo root. Never run with shell tracing enabled.
set +x
set -euo pipefail
umask 077
ENV_FILE=.env
LOG_FILE=
TMP_FILE=
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1'"; }
cleanup() {
  [ -z "$LOG_FILE" ] || rm -f -- "$LOG_FILE"
  [ -z "$TMP_FILE" ] || rm -f -- "$TMP_FILE"
  unset SESSION_SECRET PUBLISHER_PRIVATE_KEY SETUP_PRIVATE_KEY PINATA_JWT
}
trap cleanup EXIT
need openssl; need docker; need pnpm; need node
[ -f docker-compose.yml ] && [ -f .env.example ] || die 'run this from the ENSure repo root'
[ ! -L "$ENV_FILE" ] || die 'refusing a symlink .env'
if [ -e "$ENV_FILE" ]; then
  read -rp '.env exists. Replace it? A private backup will be kept. [y/N] ' answer
  [[ "$answer" =~ ^[Yy]$ ]] || die 'aborted'
  cp -p -- "$ENV_FILE" ".env.bak.$(date +%s)"
fi
pnpm install --frozen-lockfile >/dev/null 2>&1 || die 'dependency installation failed; run pnpm install before supplying secrets'
SESSION_SECRET=$(openssl rand -hex 32)
printf 'Generated a new SESSION_SECRET.\n'
read -rsp 'SEPOLIA_RPC_URL (hidden; Enter = public Sepolia): ' SEPOLIA_RPC_URL; printf '\n'
SEPOLIA_RPC_URL=${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
[[ "$SEPOLIA_RPC_URL" =~ ^https?:// ]] || die 'RPC must start with http(s)://'
read -rsp 'PUBLISHER_PRIVATE_KEY (hidden; fresh Sepolia test account): ' PUBLISHER_PRIVATE_KEY; printf '\n'
[[ "$PUBLISHER_PRIVATE_KEY" == 0x* ]] || PUBLISHER_PRIVATE_KEY="0x$PUBLISHER_PRIVATE_KEY"
[[ "$PUBLISHER_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || die 'private key must be 32 bytes of hex'
read -rsp 'PINATA_JWT with Admin scopes (hidden): ' PINATA_JWT; printf '\n'
[ -n "$PINATA_JWT" ] || die 'Pinata JWT is empty'
read -rsp 'SETUP_PRIVATE_KEY (hidden; Enter = publisher account): ' SETUP_PRIVATE_KEY; printf '\n'
SETUP_PRIVATE_KEY=${SETUP_PRIVATE_KEY:-$PUBLISHER_PRIVATE_KEY}
[[ "$SETUP_PRIVATE_KEY" == 0x* ]] || SETUP_PRIVATE_KEY="0x$SETUP_PRIVATE_KEY"
[[ "$SETUP_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || die 'setup key must be 32 bytes of hex'
export SESSION_SECRET SEPOLIA_RPC_URL PUBLISHER_PRIVATE_KEY SETUP_PRIVATE_KEY PINATA_JWT
# Keys travel only through the child environment, never process arguments or output.
PUBLISHER_ADDRESS=$(node --input-type=module -e '
import { privateKeyToAccount } from "viem/accounts";
try {
 const p = privateKeyToAccount(process.env.PUBLISHER_PRIVATE_KEY);
 privateKeyToAccount(process.env.SETUP_PRIVATE_KEY);
 console.log(p.address);
} catch { process.exit(1); }
' 2>/dev/null) || die 'publisher or setup private key is invalid'
export PUBLISHER_ADDRESS
read -rp 'Already-registered platform ENS name (e.g. myplatform.eth): ' ENS_NAME
[[ "$ENS_NAME" =~ ^[^[:space:]]+\.eth$ ]] || die 'name must end in .eth and contain no whitespace'
printf 'This runs the existing platform setup (not the isolated ENSv2 owner tooling).\n'
printf 'The setup wallet must own that name and have Sepolia ETH. Setup sends transactions.\n'
read -rp 'Run setup and send its Sepolia transactions now? [y/N] ' answer
[[ "$answer" =~ ^[Yy]$ ]] || die 'aborted before database or on-chain changes'
write_env() {
  TMP_FILE=$(mktemp .env.tmp.XXXXXX)
  export TMP_FILE
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const values = {
 DATABASE_URL: 'postgres://ensure:ensure_local_only@localhost:5432/ensure',
 SESSION_SECRET: process.env.SESSION_SECRET,
 SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
 PUBLISHER_PRIVATE_KEY: process.env.PUBLISHER_PRIVATE_KEY,
 PINATA_JWT: process.env.PINATA_JWT,
 SETUP_PRIVATE_KEY: '', // One-time key is passed only in the child environment.
 PUBLISHER_ADDRESS: process.env.PUBLISHER_ADDRESS,
 PLATFORM_NAME: process.env.PLATFORM_NAME ?? '',
 PLATFORM_REGISTRY: process.env.PLATFORM_REGISTRY ?? '',
 PLATFORM_RESOLVER: process.env.PLATFORM_RESOLVER ?? '',
};
// Preserve every template key and comment. JSON quoting prevents dotenv injection.
const text = readFileSync('.env.example', 'utf8').replace(/^([A-Z][A-Z0-9_]*)=.*$/gm,
 (line, key) => Object.hasOwn(values, key) ? key + '=' + JSON.stringify(values[key]) : line);
writeFileSync(process.env.TMP_FILE, text, { mode: 0o600 });
NODE
  chmod 600 "$TMP_FILE"
  mv -- "$TMP_FILE" "$ENV_FILE"
  TMP_FILE=
}
# The setup key is never persisted. Partial config remains on failure; inspect chain state before retrying.
write_env
printf 'Starting local Postgres...\n'
docker compose up -d postgres
ready=false
for ((i=0;i<30;i++)); do
  if docker compose exec -T postgres pg_isready -U ensure -d ensure >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || die 'Postgres did not become ready; partial .env retained'
LOG_FILE=$(mktemp .env.setup.XXXXXX)
# Never print raw RPC errors, which can echo credential-bearing provider URLs.
if ! pnpm -s setup-ens platform "$ENS_NAME" >"$LOG_FILE" 2>&1; then
  SETUP_PRIVATE_KEY=; export SETUP_PRIVATE_KEY; write_env
  die 'setup-ens failed; partial .env retained, setup key removed. Inspect chain state before retrying.'
fi
# The existing setup command persists only public deployment metadata.
PLATFORM_NAME=$(node --input-type=module -e 'import {readFileSync} from "node:fs";console.log(JSON.parse(readFileSync("deployments/sepolia.json","utf8")).platform.name)')
PLATFORM_REGISTRY=$(node --input-type=module -e 'import {readFileSync} from "node:fs";console.log(JSON.parse(readFileSync("deployments/sepolia.json","utf8")).platform.registry)')
PLATFORM_RESOLVER=$(node --input-type=module -e 'import {readFileSync} from "node:fs";console.log(JSON.parse(readFileSync("deployments/sepolia.json","utf8")).platform.resolver)')
[[ "$PLATFORM_NAME" == "$ENS_NAME" && "$PLATFORM_REGISTRY" =~ ^0x[0-9a-fA-F]{40}$ && "$PLATFORM_RESOLVER" =~ ^0x[0-9a-fA-F]{40}$ ]] || die 'invalid public platform output; inspect deployment state before retrying'
export PLATFORM_NAME PLATFORM_REGISTRY PLATFORM_RESOLVER
SETUP_PRIVATE_KEY=; export SETUP_PRIVATE_KEY
write_env
printf 'Ready: .env written with mode 600; one-time setup key removed.\n'
printf 'PLATFORM_NAME=%s\nPLATFORM_REGISTRY=%s\nPLATFORM_RESOLVER=%s\n' "$PLATFORM_NAME" "$PLATFORM_REGISTRY" "$PLATFORM_RESOLVER"
printf 'Next: configure login/GitHub integrations as needed, then pnpm server.\n'
