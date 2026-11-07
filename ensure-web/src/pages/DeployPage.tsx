import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowUpRight, Check, CheckCircle2, Fingerprint, LoaderCircle, Rocket, Signature, Square, Terminal, Wallet2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useAccount, useSignMessage, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { parseAbi } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyValue } from "@/components/CopyValue";
import { SectionHeading } from "@/components/SectionHeading";
import { SignInPrompt } from "@/components/SignInPrompt";
import {
  connectRepo, deployStream, getBranches, getConnectedRepos, getCustomDomains, getDeployStatus, getRepos,
  getDomainAccess, initCustomDomain, verifyCustomDomain, type DeployReceipt,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useWalletConnect } from "@/lib/wallet";
import { etherscanTx, shortAddress, shortCid } from "@/lib/utils";

const setContenthashAbi = parseAbi(["function setContenthash(bytes name, bytes hash)"]);

type Phase = "idle" | "running" | "done" | "failed";
const selectClass = "inset-input h-12 w-full rounded-2xl border px-4 text-sm text-foreground outline-none focus:border-foreground/50 focus:ring-2 focus:ring-ring/15 disabled:opacity-50";

function treeUrl(fullName: string, branch: string, folder: string) {
  const sub = folder.trim().replace(/^\/+|\/+$/g, "");
  return `https://github.com/${fullName}/tree/${encodeURIComponent(branch)}${sub ? `/${sub}` : ""}`;
}

export function DeployPage() {
  const session = useSession();
  if (session.isLoading) return <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Checking your session…</div>;
  if (!session.signedIn) return <SignInPrompt title="Sign in to deploy" description="Deploys run on the backend: it clones the repository, builds it, pins the output to IPFS and updates the ENS name." />;
  return <DeployForm canManageRepos={Boolean(session.me?.canManageRepos)} />;
}

function DeployForm({ canManageRepos }: { canManageRepos: boolean }) {
  const queryClient = useQueryClient();
  const repos = useQuery({ queryKey: ["gh-repos"], queryFn: getRepos, enabled: canManageRepos, staleTime: 60_000 });
  const connected = useQuery({ queryKey: ["gh-connected"], queryFn: getConnectedRepos, enabled: canManageRepos });
  const customDomains = useQuery({ queryKey: ["custom-domains"], queryFn: getCustomDomains });
  const status = useQuery({ queryKey: ["deploy-status"], queryFn: getDeployStatus, refetchInterval: 10_000 });

  const [repoFullName, setRepoFullName] = useState("");
  const [branch, setBranch] = useState("");
  const [folder, setFolder] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [env, setEnv] = useState<"production" | "preview">("preview");
  const [mode, setMode] = useState<"auto" | "custom">("custom");
  const [label, setLabel] = useState("");
  const [customName, setCustomName] = useState("");
  const [meta, setMeta] = useState("");
  const [watchPushes, setWatchPushes] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<DeployReceipt>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const abortRef = useRef<() => void>(undefined);
  const logRef = useRef<HTMLPreElement>(null);

  const [owner, repo] = repoFullName.split("/");
  const branches = useQuery({ queryKey: ["gh-branches", repoFullName], queryFn: () => getBranches(owner!, repo!), enabled: Boolean(owner && repo) });
  function chooseRepo(fullName: string) {
    setRepoFullName(fullName);
    setBranch(repos.data?.repos.find((r) => r.fullName === fullName)?.defaultBranch ?? "");
  }
  useEffect(() => () => abortRef.current?.(), []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs]);

  const repoUrl = repoFullName && branch ? treeUrl(repoFullName, branch, folder) : manualUrl.trim();
  const verifiedName = customDomains.data?.domains.find((d) => d.ensName === customName);
  const domain = mode === "auto" ? (label.trim() || "auto") : customName;
  const running = phase === "running";
  const canSubmit = Boolean(repoUrl) && !running && (mode === "auto" || Boolean(verifiedName));

  function applyConnection(key: string) {
    const match = connected.data?.repos.find((r) => `${r.repoFullName}::${r.branch}` === key);
    if (!match) return;
    setRepoFullName(match.repoFullName);
    setBranch(match.branch);
    setFolder("");
    setEnv(match.env === "production" ? "production" : "preview");
    setMode(match.domainMode);
    if (match.domainMode === "custom") setCustomName(match.customEnsName || match.domain);
    else setLabel(match.domain);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(undefined);
    setNotice(undefined);
    setReceipt(undefined);
    setLogs([]);
    setPhase("running");

    if (watchPushes && repoFullName && branch) {
      try {
        const result = await connectRepo({ repoFullName, branch, domain: mode === "auto" ? (label.trim() || undefined) : undefined, domainMode: mode, customEnsName: mode === "custom" ? customName : undefined, env });
        setNotice(result.message);
        void queryClient.invalidateQueries({ queryKey: ["gh-connected"] });
      } catch (err) {
        setNotice(`Push deploys were not enabled: ${err instanceof Error ? err.message : "request failed"}`);
      }
    }

    abortRef.current = deployStream(
      { repoUrl, domain, env, meta: meta.trim(), domainMode: mode, ipnsKey: mode === "custom" ? verifiedName?.ipnsKey : null },
      {
        onLog: (line) => setLogs((current) => [...current, line]),
        onDone: (r) => { setReceipt(r); setPhase("done"); void queryClient.invalidateQueries({ queryKey: ["sites"] }); void status.refetch(); },
        onError: (message) => { setError(message); setPhase("failed"); void status.refetch(); },
      },
    );
    void status.refetch();
  }

  function cancel() {
    abortRef.current?.();
    setPhase("failed");
    setError("Stream closed in the browser. The backend may still finish this deploy; check Sites.");
  }

  return <div>
    <SectionHeading eyebrow="Deployment backend / build pipeline" title="Deploy a site" description="The backend clones the repository, builds it, pins the output to IPFS, updates the ENS name and logs the deploy on Sepolia. A preview deploy is a candidate; promoting to production is still an owner decision."
      action={status.data && <Badge variant={status.data.active >= status.data.max ? "warning" : "neutral"}>{status.data.active}/{status.data.max} builds running</Badge>} />

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <form onSubmit={(e) => void submit(e)} className="space-y-6">
        <Card><CardHeader><CardTitle>1 · Source</CardTitle></CardHeader><CardContent className="space-y-4">
          {canManageRepos && (connected.data?.repos.length ?? 0) > 0 && <Field label="Connected repository">
            <select className={selectClass} defaultValue="" onChange={(e) => applyConnection(e.target.value)} disabled={running}>
              <option value="">Choose a connected repo…</option>
              {connected.data!.repos.map((r) => <option key={`${r.repoFullName}::${r.branch}`} value={`${r.repoFullName}::${r.branch}`}>{r.repoFullName} · {r.branch} → {r.domain}</option>)}
            </select>
          </Field>}
          {canManageRepos ? <>
            <Field label="Repository" hint={repos.error ? (repos.error as Error).message : undefined}>
              <select className={selectClass} value={repoFullName} onChange={(e) => chooseRepo(e.target.value)} disabled={running || repos.isLoading}>
                <option value="">{repos.isLoading ? "Loading your repositories…" : "Paste a URL below, or choose a repository"}</option>
                {repos.data?.repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? " (private)" : ""}</option>)}
              </select>
            </Field>
            {repoFullName && <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Branch"><select className={selectClass} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={running || branches.isLoading}>
                {(branches.data?.branches ?? [branch]).filter(Boolean).map((b) => <option key={b} value={b}>{b}</option>)}
              </select></Field>
              <Field label="Folder (optional)"><Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="apps/site" disabled={running} /></Field>
            </div>}
          </> : <p className="text-xs leading-5 text-muted-foreground">Signed in with Google: paste a public repository URL. Sign in with GitHub to pick private repos and deploy on push.</p>}
          {!repoFullName && <Field label="Repository URL"><Input value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="https://github.com/owner/repo/tree/main/site" disabled={running} inputMode="url" /></Field>}
          {repoUrl && <p className="break-all font-mono text-[11px] text-muted-foreground">{repoUrl}</p>}
        </CardContent></Card>

        <Card><CardHeader><CardTitle>2 · Name and environment</CardTitle></CardHeader><CardContent className="space-y-4">
          <Field label="Environment">
            <Tabs value={env} onValueChange={(v) => setEnv(v as "production" | "preview")}><TabsList aria-label="Deploy environment"><TabsTrigger value="preview" disabled={running}>Preview</TabsTrigger><TabsTrigger value="production" disabled={running}>Production</TabsTrigger></TabsList></Tabs>
          </Field>
          <Field label="ENS name">
            <Tabs value={mode} onValueChange={(v) => setMode(v as "auto" | "custom")}><TabsList aria-label="ENS name mode"><TabsTrigger value="custom" disabled={running}>My ENSv2 name</TabsTrigger><TabsTrigger value="auto" disabled={running}>Managed subname</TabsTrigger></TabsList></Tabs>
          </Field>
          {mode === "auto"
            ? <Field label="Subname (optional)" hint="Off-chain subname issued by Namespace under the backend's parent name. Needs NAMESPACE_API_KEY on the backend; leave empty to get a random one."><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="auto" disabled={running} /></Field>
            : <CustomNamePicker value={customName} onChange={setCustomName} disabled={running} />}
          <Field label="Note (optional)"><Input value={meta} onChange={(e) => setMeta(e.target.value)} placeholder="Release notes or ticket" disabled={running} maxLength={200} /></Field>
          {canManageRepos && repoFullName && <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 accent-current" checked={watchPushes} onChange={(e) => setWatchPushes(e.target.checked)} disabled={running} /><span><span className="font-medium">Redeploy on every push</span><span className="block text-xs leading-5 text-muted-foreground">Adds a GitHub webhook for {repoFullName} · {branch}.</span></span></label>}
        </CardContent></Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" disabled={!canSubmit}>{running ? <LoaderCircle className="size-4 animate-spin" /> : <Rocket className="size-4" />}{running ? "Deploying…" : `Deploy to ${env}`}</Button>
          {running && <Button type="button" variant="ghost" onClick={cancel}><Square className="size-4" /> Stop watching</Button>}
          {mode === "custom" && !verifiedName && <span className="text-xs text-muted-foreground">Verify an ENS name first.</span>}
        </div>
      </form>

      <div className="space-y-6 xl:sticky xl:top-24 xl:self-start">
        <Card><CardHeader className="flex-row items-center justify-between gap-3"><CardTitle className="flex items-center gap-2"><Terminal className="size-4" /> Build log</CardTitle><PhaseBadge phase={phase} /></CardHeader><CardContent>
          <pre ref={logRef} aria-live="polite" className="inset-input h-[380px] overflow-auto whitespace-pre-wrap break-words rounded-2xl p-4 font-mono text-[11px] leading-5 text-muted-foreground">{logs.length ? logs.join("\n") : running ? "Waiting for the backend…" : "Logs stream here while the pipeline runs."}</pre>
          {notice && <p className="mt-3 text-xs leading-5 text-muted-foreground">{notice}</p>}
          {error && <div role="alert" className="mt-3 flex gap-3 rounded-2xl border border-foreground/30 bg-foreground/[0.06] p-4 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span className="break-words">{error}</span></div>}
        </CardContent></Card>
        {receipt && <ReceiptCard receipt={receipt} />}
      </div>
    </div>
  </div>;
}

function ReceiptCard({ receipt }: { receipt: DeployReceipt }) {
  const gateway = receipt.gateways?.ipfs_io ?? `https://ipfs.io/ipfs/${receipt.cid}/`;
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-4" /> Deployed {receipt.elapsed && <span className="font-normal text-muted-foreground">in {receipt.elapsed}</span>}</CardTitle></CardHeader><CardContent className="space-y-4">
    <dl className="grid gap-4 sm:grid-cols-2">
      <Detail label="Site CID"><CopyValue value={receipt.cid} className="font-mono text-xs">{shortCid(receipt.cid)}</CopyValue></Detail>
      <Detail label="ENS name"><CopyValue value={receipt.ens?.name ?? receipt.domain} className="font-mono text-xs">{receipt.ens?.name ?? receipt.domain}</CopyValue></Detail>
      <Detail label="ENS status"><span className="text-xs">{ensStatusText(receipt)}</span></Detail>
      <Detail label="Environment · framework"><span className="text-xs">{receipt.env} · {receipt.framework ?? "static"}</span></Detail>
    </dl>
    {receipt.ens?.status === "pending-owner-transaction" && receipt.ens.resolver && receipt.ens.dnsName && receipt.ens.contenthashHex && <PublishFromWallet receipt={receipt} />}
    {receipt.ens?.txHash && <a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" href={etherscanTx(receipt.ens.txHash)} target="_blank" rel="noreferrer">ENS update transaction <ArrowUpRight className="size-3" /></a>}
    <div className="flex flex-wrap gap-2">
      <Button asChild size="sm" variant="secondary"><a href={gateway} target="_blank" rel="noreferrer">Open on IPFS <ArrowUpRight className="size-3.5" /></a></Button>
      <Button asChild size="sm" variant="ghost"><Link to={`/sites/${encodeURIComponent(receipt.domain)}`}>Deploy history</Link></Button>
      <Button asChild size="sm" variant="ghost"><Link to="/verify"><Fingerprint className="size-3.5" /> Verify</Link></Button>
    </div>
  </CardContent></Card>;
}

function ensStatusText(receipt: DeployReceipt) {
  const status = receipt.ens?.status;
  if (status === "updated" && receipt.ens?.protocol === "ensv2") return "ENSv2 contenthash updated by the backend";
  if (status === "updated" || status === "created") return `Subname ${status}`;
  if (status === "pending-owner-transaction") return "Waiting for your wallet to point the name at this CID";
  if (status === "no-resolver") return "The name has no ENSv2 resolver set";
  return status ?? "—";
}

/** Sends resolver.setContenthash(name, ipfs://cid) from the connected owner wallet (ENSv2). */
function PublishFromWallet({ receipt }: { receipt: DeployReceipt }) {
  const ens = receipt.ens!;
  const account = useAccount();
  const wallet = useWalletConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const write = useWriteContract();
  const confirmed = useWaitForTransactionReceipt({ hash: write.data, chainId: sepolia.id });
  const publish = () => write.writeContract({
    address: ens.resolver as `0x${string}`,
    abi: setContenthashAbi,
    functionName: "setContenthash",
    args: [ens.dnsName!, ens.contenthashHex!],
    chainId: sepolia.id,
  });
  const error = write.error as { shortMessage?: string; message?: string } | null;

  return <div className="rounded-2xl border border-dashed border-foreground/20 p-4">
    <p className="eyebrow mb-2">Publish to {ens.name}</p>
    <p className="text-xs leading-5 text-muted-foreground">The backend wallet may not change this name's records, so the deploy is live on IPFS but {ens.name} still points at its previous content. Approve one ENSv2 transaction from a wallet with SET_CONTENTHASH on resolver <span className="font-mono">{shortAddress(ens.resolver ?? undefined)}</span>.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {confirmed.isSuccess ? <Badge variant="success"><Check className="size-3.5" /> {ens.name} now points at this deploy</Badge>
        : !account.isConnected ? <Button size="sm" onClick={() => wallet.connectWallet()} disabled={wallet.isPending}><Wallet2 className="size-4" /> {wallet.isPending ? "Check your wallet…" : "Connect wallet"}</Button>
        : account.chainId !== sepolia.id ? <Button size="sm" variant="secondary" onClick={() => switchChain({ chainId: sepolia.id })} disabled={switching}>Switch to Sepolia</Button>
        : <Button size="sm" onClick={publish} disabled={write.isPending || confirmed.isLoading}>{write.isPending || confirmed.isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <Signature className="size-4" />}{write.isPending ? "Confirm in wallet…" : confirmed.isLoading ? "Waiting for confirmation…" : `Point ${ens.name} at this deploy`}</Button>}
      {write.data && <a className="text-xs text-muted-foreground underline underline-offset-4" href={etherscanTx(write.data)} target="_blank" rel="noreferrer">Transaction ↗</a>}
    </div>
    {wallet.error && !account.isConnected && <p role="alert" className="mt-2 text-xs">{wallet.error}</p>}
    {error && <p role="alert" className="mt-2 break-words text-xs">{/revert/i.test(error.shortMessage ?? error.message ?? "") ? "The resolver rejected this wallet: it lacks SET_CONTENTHASH for this name. Use the wallet that controls the name's records." : error.shortMessage ?? error.message}</p>}
  </div>;
}

/** Live ENSv2 check: can the backend wallet publish this name automatically? */
function NameAccess({ name }: { name: string }) {
  const access = useQuery({ queryKey: ["domain-access", name], queryFn: () => getDomainAccess(name), staleTime: 30_000 });
  if (access.isLoading) return <p className="text-xs text-muted-foreground">Checking ENSv2 resolver permissions…</p>;
  if (access.error || !access.data) return <p className="text-xs text-muted-foreground">Resolver permissions could not be read{access.error instanceof Error ? `: ${access.error.message}` : ""}.</p>;
  const { backendCanPublish, resolver, publisher } = access.data;
  if (!resolver || /^0x0+$/.test(resolver)) return <p className="text-xs leading-5 text-foreground">{name} has no ENSv2 resolver. Set one before deploying, or the name cannot serve the site.</p>;
  return backendCanPublish
    ? <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground"><Check className="mt-0.5 size-3.5 shrink-0" /> The backend wallet may set this name's contenthash, so each deploy goes live at {name} automatically.</p>
    : <p className="text-xs leading-5 text-muted-foreground">After each deploy you'll approve one transaction pointing {name} at the new CID. To skip that, grant SET_CONTENTHASH on resolver <span className="font-mono">{shortAddress(resolver)}</span> to the backend wallet <span className="font-mono">{shortAddress(publisher ?? undefined)}</span>.</p>;
}

function CustomNamePicker({ value, onChange, disabled }: { value: string; onChange: (name: string) => void; disabled: boolean }) {
  const queryClient = useQueryClient();
  const domains = useQuery({ queryKey: ["custom-domains"], queryFn: getCustomDomains });
  const account = useAccount();
  const wallet = useWalletConnect();
  const [triedConnect, setTriedConnect] = useState(false);
  const { signMessageAsync } = useSignMessage();
  const [newName, setNewName] = useState("");
  const verified = useMemo(() => domains.data?.domains ?? [], [domains.data]);

  const verify = useMutation({
    mutationFn: async (ensName: string) => {
      if (!account.address) throw new Error("Connect the wallet that owns this name.");
      const challenge = await initCustomDomain(ensName, account.address);
      const signature = await signMessageAsync({ message: challenge.message });
      return verifyCustomDomain(challenge.ensName, account.address, signature);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["custom-domains"] });
      onChange(result.ensName);
      setNewName("");
    },
  });

  return <div className="space-y-4">
    <Field label="Verified name">
      <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || domains.isLoading}>
        <option value="">{domains.isLoading ? "Loading…" : verified.length ? "Choose a verified name" : "No verified names yet"}</option>
        {verified.map((d) => <option key={d.ensName} value={d.ensName}>{d.ensName}</option>)}
      </select>
    </Field>
    {value && verified.some((d) => d.ensName === value) && <NameAccess name={value} />}
    <div className="rounded-2xl border border-dashed border-foreground/15 p-4">
      <p className="eyebrow mb-3">Verify another name</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={newName} onChange={(e) => setNewName(e.target.value.trim().toLowerCase())} placeholder="yourname.eth" disabled={disabled || verify.isPending} />
        {account.isConnected
          ? <Button type="button" variant="secondary" className="h-12 shrink-0" disabled={!newName.includes(".") || disabled || verify.isPending} onClick={() => verify.mutate(newName)}>{verify.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Signature className="size-4" />} Sign to verify</Button>
          : <Button type="button" variant="secondary" className="h-12 shrink-0" disabled={wallet.isPending} onClick={() => { setTriedConnect(true); wallet.connectWallet(); }}>{wallet.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Wallet2 className="size-4" />} {wallet.isPending ? "Check your wallet…" : "Connect wallet"}</Button>}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">The backend checks ENSv2 on Sepolia that the connected wallet owns the name, then asks you to sign a challenge. No transaction is sent.</p>
      {!account.isConnected && (triedConnect || !wallet.walletAvailable) && wallet.error && !wallet.isPending && <p role="alert" className="mt-2 text-xs text-foreground">{wallet.error}{!wallet.walletAvailable && <> <a className="underline underline-offset-4" href="https://metamask.io/download/" target="_blank" rel="noreferrer">Get MetaMask ↗</a></>}</p>}
      {verify.error && <p role="alert" className="mt-2 text-xs text-foreground">{verify.error instanceof Error ? verify.error.message : "Verification failed"}</p>}
      {verify.isSuccess && <p className="mt-2 flex items-center gap-1.5 text-xs"><Check className="size-3.5" /> {verify.data.ensName} verified.</p>}
    </div>
  </div>;
}

function PhaseBadge({ phase }: { phase: Phase }) {
  if (phase === "running") return <Badge variant="neutral"><LoaderCircle className="size-3.5 animate-spin" /> Running</Badge>;
  if (phase === "done") return <Badge variant="success"><Check className="size-3.5" /> Complete</Badge>;
  if (phase === "failed") return <Badge variant="danger"><AlertCircle className="size-3.5" /> Failed</Badge>;
  return <Badge variant="neutral">Idle</Badge>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="space-y-2"><div className="eyebrow">{label}</div>{children}{hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="eyebrow">{label}</dt><dd className="mt-1.5 min-w-0">{children}</dd></div>;
}
