// Gateway fetching for verification. Runtime-neutral (browser and Node); the gateway list is passed in.
// Gateway choice affects availability only: callers always compare bytes against CIDs and hashes.

export class GatewayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUnavailableError";
  }
}

/** A gateway returned bytes, but none matched the expected hash: data was readable and differed. */
export class GatewayContentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayContentMismatchError";
  }
}

/** Filebase serves HTML and JSON with CORS; Pinata's subdomain gateway refuses HTML; ipfs.io / dweb.link return 429. */
export const DEFAULT_GATEWAYS = ["https://ipfs.filebase.io", "https://ipfs.io", "https://dweb.link"] as const;

export function normalizeGateways(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)).map((v) => v.replace(/\/$/, "")))];
}

/** `ipfs://<cid>[/path]` or a bare CID → the CID. */
export function cidFromPointer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const cid = trimmed.startsWith("ipfs://") ? trimmed.slice("ipfs://".length).split("/")[0] : trimmed;
  return cid || undefined;
}

const inBrowser = typeof window !== "undefined";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pathFor(cid: string, path?: string) {
  const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `/ipfs/${encodeURIComponent(cid)}${suffix}`;
}

type Fetched = { bytes: Uint8Array; gateway: string; url: string };

export function createIpfsFetcher(gatewayList: readonly string[], options: { timeoutMs?: number } = {}) {
  const gateways = normalizeGateways(gatewayList);
  const timeoutMs = options.timeoutMs ?? 12_000;

  /** Tries each gateway in order; retries 429 briefly. `matches` decides whether bytes are acceptable. */
  async function attempt(cid: string, path: string | undefined, matches?: (bytes: Uint8Array) => boolean): Promise<Fetched> {
    let lastError = "No gateway configured";
    let receivedBytes = false;
    for (const gateway of gateways) {
      const url = `${gateway}${pathFor(cid, path)}`;
      for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(inBrowser ? { cache: "no-store" as RequestCache } : {}) });
          if (response.status === 429 && attemptNo < 2) {
            const retryAfter = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2500) : 350 * (2 ** attemptNo));
            continue;
          }
          if (!response.ok) {
            lastError = `${new URL(gateway).host} returned HTTP ${response.status}`;
            break;
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (!matches) return { bytes, gateway, url };
          receivedBytes = true;
          if (matches(bytes)) return { bytes, gateway, url };
          lastError = `${new URL(gateway).host} returned bytes that do not match the expected file hash`;
          break;
        } catch (error) {
          lastError = `${new URL(gateway).host}: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
    }
    if (receivedBytes) throw new GatewayContentMismatchError(lastError);
    throw new GatewayUnavailableError(lastError);
  }

  return {
    gateways,
    fetchIpfs: (cid: string, path?: string) => attempt(cid, path),
    fetchIpfsMatching: (cid: string, path: string | undefined, matches: (bytes: Uint8Array) => boolean) => attempt(cid, path, matches),
  };
}
