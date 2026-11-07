/**
 * Client for the existing deployment backend (backend/, Express on :3001).
 * The backend handles OAuth, GitHub repo access, the build → IPFS → ENS pipeline,
 * and on-chain deploy history. ENSure keeps signing release approvals in the wallet.
 */

const trimSlash = (value: string) => value.replace(/\/$/, "");

export const API_BASE = trimSlash(import.meta.env.VITE_API_URL?.trim() || "http://localhost:3001");
export const AUTH_BASE = trimSlash(import.meta.env.VITE_AUTH_API_URL?.trim() || API_BASE);

const TOKEN_KEY = "ensure_backend_token";
export const TOKEN_EVENT = "ensure-token-change";
let memoryToken: string | null = null;
const announce = () => window.dispatchEvent(new Event(TOKEN_EVENT));

// ── Token storage ────────────────────────────────────────────────────────────

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function saveToken(token: string) {
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be unavailable in private windows; the session then lasts for this page only.
  }
  announce();
}

export function clearToken() {
  memoryToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
  announce();
}

export function isTokenExpired(token: string | null = getToken()): boolean {
  if (!token) return true;
  const payload = token.split(".")[1];
  if (!payload) return true;
  try {
    const { exp } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return exp ? Date.now() >= exp * 1000 : false;
  } catch {
    return true;
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, base = API_BASE): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(`The deployment backend at ${base} could not be reached.`, 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401) clearToken();
    throw new ApiError(body.error || `Request failed (HTTP ${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface User {
  sub: string;
  provider: "github" | "google" | string;
  login: string;
  name: string;
  email: string;
  avatar: string;
}

export interface Me {
  user: User;
  tokenExpires: string;
  canManageRepos: boolean;
}

export interface AuthProvider {
  id: string;
  name: string;
  url: string;
  available: boolean;
  note: string;
}

export const getMe = () => request<Me>("/api/auth/me", {}, AUTH_BASE);
export const getAuthProviders = () => request<{ providers: AuthProvider[] }>("/api/auth/providers", {}, AUTH_BASE);
export const loginUrl = (provider: string) => `${AUTH_BASE}/api/auth/${encodeURIComponent(provider)}`;

export async function logout() {
  await request("/api/auth/logout", { method: "POST" }, AUTH_BASE).catch(() => undefined);
  clearToken();
}

// ── Sites (public, read from DeployRegistry / IPNSRegistry) ──────────────────

export interface Deploy {
  cid: string;
  deployer: string;
  env: string;
  meta: string;
  timestamp: number;
  url: string;
}

export interface SiteDetail {
  domain: string;
  count: number;
  latest: Deploy | null;
  history: Deploy[];
}

export interface IpnsEntry {
  domain: string;
  ipnsKey: string;
  latestCid: string;
  latestSeq: number;
  registeredAt: number;
  updatedAt: number;
  active: boolean;
  gateways: string[];
  url: string;
}

export const getSites = () => request<{ domains: string[] }>("/api/sites");
export const getSite = (domain: string, limit = 20) => request<SiteDetail>(`/api/sites/${encodeURIComponent(domain)}?limit=${limit}`);
export const getSiteIpns = (domain: string) => request<IpnsEntry>(`/api/sites/${encodeURIComponent(domain)}/ipns`);

// ── Deploy ───────────────────────────────────────────────────────────────────

export interface DeployStatus { active: number; max: number }

export interface DeployReceipt {
  cid: string;
  domain: string;
  env: string;
  framework?: string;
  elapsed?: string;
  timestamp?: string;
  gateways?: Record<string, string>;
  ens?: {
    mode?: "auto" | "custom";
    protocol?: "ensv2";
    name?: string;
    contenthash?: string | null;
    /** ENS-encoded contenthash bytes (0xe301…) for setContenthash. */
    contenthashHex?: `0x${string}`;
    /** DNS-wire-encoded name for setContenthash. */
    dnsName?: `0x${string}`;
    resolver?: `0x${string}` | null;
    txHash?: string;
    managedBy?: "server" | "wallet";
    status?: "updated" | "created" | "pending-owner-transaction" | "no-resolver" | string;
  };
  ipns?: { key?: string | null };
  contracts?: Record<string, string | undefined>;
}

export interface DeployRequest {
  repoUrl: string;
  domain: string;
  env: "production" | "preview";
  meta?: string;
  domainMode: "auto" | "custom";
  ipnsKey?: string | null;
}

export const getDeployStatus = () => request<DeployStatus>("/api/deploy/status");

/**
 * Starts a deploy on POST /api/deploy and parses its Server-Sent Events stream.
 * Returns a function that aborts the stream.
 */
export function deployStream(
  body: DeployRequest,
  handlers: { onStart?: () => void; onLog: (line: string) => void; onDone: (receipt: DeployReceipt) => void; onError: (message: string) => void },
): () => void {
  const controller = new AbortController();
  const token = getToken();

  void (async () => {
    let finished = false;
    try {
      const res = await fetch(`${API_BASE}/api/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 401) clearToken();
        handlers.onError(err.error || `Deploy failed (HTTP ${res.status})`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          let event = "";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!event || !data) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === "start") handlers.onStart?.();
          else if (event === "log") handlers.onLog((parsed as { line: string }).line);
          else if (event === "done") { finished = true; handlers.onDone(parsed as DeployReceipt); }
          else if (event === "error") { finished = true; handlers.onError((parsed as { message?: string }).message || "Deploy failed"); }
        }
      }
      if (!finished) handlers.onError("The deploy stream closed before the pipeline finished.");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      handlers.onError(`The deployment backend at ${API_BASE} could not be reached.`);
    }
  })();

  return () => controller.abort();
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface Repo {
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  connected: boolean;
}

export interface ConnectedRepo {
  repoFullName: string;
  owner: string;
  repo: string;
  branch: string;
  domain: string;
  domainMode: "auto" | "custom";
  customEnsName?: string | null;
  ipnsKey?: string | null;
  env: string;
  webhookId: number | null;
  connectedBy: string;
  recentDeploys?: Deploy[];
}

export const getRepos = () => request<{ repos: Repo[] }>("/api/github/repos");
export const getBranches = (owner: string, repo: string) =>
  request<{ branches: string[] }>(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
export const getConnectedRepos = () => request<{ repos: ConnectedRepo[] }>("/api/github/connected");
export const connectRepo = (data: { repoFullName: string; branch: string; domain?: string; domainMode: "auto" | "custom"; customEnsName?: string; env: string }) =>
  request<{ ok: boolean; message: string; domain: string; webhookId: number | null }>("/api/github/connect", { method: "POST", body: JSON.stringify(data) });
export const disconnectRepo = (owner: string, repo: string, branch: string) =>
  request<{ ok: boolean }>(`/api/github/connected/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`, { method: "DELETE" });

// ── Custom ENS names ─────────────────────────────────────────────────────────

export interface CustomDomain {
  ensName: string;
  walletAddress: string;
  ipnsKey: string;
  ensToIpnsStatus: string;
  ensToIpnsConfigured: boolean;
  ensToIpnsTxHash: string | null;
  verifiedAt?: string;
}

export interface PublisherAccess {
  ensName: string;
  publisher: string | null;
  resolver: string | null;
  backendCanPublish: boolean;
  error?: string;
}

export const getDomainAccess = (ensName: string) => request<PublisherAccess>(`/api/domains/custom/${encodeURIComponent(ensName)}/access`);
export const getCustomDomains = () => request<{ domains: CustomDomain[] }>("/api/domains/custom");
export const initCustomDomain = (ensName: string, walletAddress: string) =>
  request<{ ensName: string; ipnsKey: string; message: string; note: string }>("/api/domains/custom/init", { method: "POST", body: JSON.stringify({ ensName, walletAddress }) });
export const verifyCustomDomain = (ensName: string, walletAddress: string, signature: string) =>
  request<CustomDomain & { ok: boolean; note: string }>("/api/domains/custom/verify", { method: "POST", body: JSON.stringify({ ensName, walletAddress, signature }) });
export const confirmCustomDomainLink = (ensName: string, txHash: string) =>
  request<{ ok: boolean }>("/api/domains/custom/confirm-link", { method: "POST", body: JSON.stringify({ ensName, txHash }) });
