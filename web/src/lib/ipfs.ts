import { GATEWAYS } from "./config";

export class GatewayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUnavailableError";
  }
}

export class GatewayContentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayContentMismatchError";
  }
}

function pathFor(cid: string, path?: string) {
  const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `/ipfs/${encodeURIComponent(cid)}${suffix}`;
}

export async function fetchIpfs(cid: string, path?: string): Promise<{ bytes: Uint8Array; gateway: string; url: string }> {
  let lastError = "No gateway configured";
  for (const gateway of [...new Set(GATEWAYS)]) {
    const url = `${gateway}${pathFor(cid, path)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
        if (response.status === 429 && attempt < 2) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2500) : 350 * (2 ** attempt);
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          continue;
        }
        if (!response.ok) {
          lastError = `${new URL(gateway).host} returned HTTP ${response.status}`;
          break;
        }
        return { bytes: new Uint8Array(await response.arrayBuffer()), gateway, url };
      } catch (error) {
        lastError = `${new URL(gateway).host}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
  }
  throw new GatewayUnavailableError(lastError);
}

export async function fetchIpfsMatching(cid: string, path: string | undefined, matches: (bytes: Uint8Array) => boolean) {
  let lastError = "No gateway configured";
  let receivedBytes = false;
  for (const gateway of [...new Set(GATEWAYS)]) {
    const url = `${gateway}${pathFor(cid, path)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
        if (response.status === 429 && attempt < 2) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2500) : 350 * (2 ** attempt);
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          continue;
        }
        if (!response.ok) {
          lastError = `${new URL(gateway).host} returned HTTP ${response.status}`;
          break;
        }
        receivedBytes = true;
        const bytes = new Uint8Array(await response.arrayBuffer());
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

export function cidFromPointer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const cid = trimmed.startsWith("ipfs://") ? trimmed.slice("ipfs://".length).split("/")[0] : trimmed;
  return cid || undefined;
}
