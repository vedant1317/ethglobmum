import { useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ArrowLeftRight, ArrowRight, Check, CircleHelp, ExternalLink, FileCheck2, Fingerprint, Globe2, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deployment } from "@/lib/config";
import { verifyProject, type Verification, type VerificationCheck } from "@/lib/verify";
import { shortAddress, shortCid, formatDate } from "@/lib/utils";

const stateIcon = { pass: Check, fail: X, unavailable: CircleHelp, info: CircleHelp } as const;
const phases = [
  { title: "Read the name", detail: "Resolve the live production and preview pointers.", icon: Globe2 },
  { title: "Check the owner", detail: "Validate the release signature against the current owner.", icon: Fingerprint },
  { title: "Compare the files", detail: "Match file sizes and hashes to the build manifest.", icon: FileCheck2 },
];

export function VerifyPage() {
  const reduceMotion = useReducedMotion();
  const [name, setName] = useState(deployment.projectName);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [result, setResult] = useState<Verification>();
  const [requestError, setRequestError] = useState<string>();
  const [running, setRunning] = useState(false);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunning(true);
    setResult(undefined);
    setRequestError(undefined);
    setChecks([]);
    try {
      const verified = await verifyProject(name, (check) => setChecks((current) => [...current.filter((item) => item.id !== check.id), check]));
      setResult(verified);
      setChecks(verified.checks);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Verification could not be completed.");
    } finally {
      setRunning(false);
    }
  }
  const status = result?.status;
  const isMatch = status === "MATCH";
  const isMismatch = status === "MISMATCH";

  const passed = checks.filter(check => check.state === "pass").length;
  const ResultIcon = running ? LoaderCircle : isMatch ? ShieldCheck : isMismatch ? AlertCircle : CircleHelp;
  return <div className="verifier-page">
    <header className="verifier-intro">
      <div className="verifier-title"><p className="eyebrow">Public verifier / No wallet needed</p><h1 className="editorial-title">A name is a promise.<br /><em>Check the <span className="word-cycle">proof.</span></em></h1><p className="editorial-description">Look past the page. Check the live ENS pointer, the owner's approval, and the exact files behind it.</p></div>
      <form onSubmit={event => void run(event)} className="verify-launch">
        <div className="verify-launch-top"><span className="verify-lens"><Fingerprint strokeWidth={1.25} aria-hidden="true" /></span><span className="eyebrow">Read-only inspection</span></div>
        <label htmlFor="verify-ens-name" className="mb-3 block text-sm font-medium">Which name should we check?</label>
        <div className="relative"><Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input id="verify-ens-name" value={name} onChange={event => setName(event.target.value)} placeholder={deployment.projectName} className="h-14 pl-11 font-mono text-base" spellCheck={false} autoComplete="off" /></div>
        <Button type="submit" size="lg" disabled={running || !name.trim()} className="mt-4 w-full">{running ? <><LoaderCircle className="size-4 animate-spin" />Inspecting release…</> : <>Verify release <ArrowRight className="size-4" /></>}</Button>
        <p className="mt-5 text-xs text-muted-foreground">ENSv2 on Sepolia · Production + preview</p>
      </form>
    </header>
    {requestError && <div role="alert" className="mb-8 rounded-2xl border border-foreground/20 px-5 py-4 text-sm leading-6">Verification failed to run: {requestError}</div>}
    <AnimatePresence mode="wait">
      {running || result ? <motion.section key="inspector" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? undefined : { opacity: 0 }} className="inspector-layout" aria-label="Verification results">
        <aside className={`inspector-summary ${isMismatch ? "inspector-mismatch" : ""}`}>
          <span className="inspector-status-icon"><ResultIcon className={running ? "animate-spin" : ""} strokeWidth={1.3} aria-hidden="true" /></span>
          <p className="eyebrow mt-6">{running ? "Inspection in progress" : "Inspection complete"}</p>
          <h2 className="mt-3 text-3xl font-medium tracking-tight" aria-live="polite">{running ? "Following the proof…" : isMatch ? "The proof checks out." : isMismatch ? "Something differs." : "Not enough proof."}</h2>
          <p className="mt-4 text-sm leading-7 text-muted-foreground">{running ? "Live checks appear as the chain reads and file fetches finish." : result?.explanation}</p>
          <div className="inspector-score"><span>{passed}<span className="text-xl text-muted-foreground">/{checks.length}</span></span><p className="eyebrow">Checks passed</p></div>
          {result && <Badge variant={isMatch ? "success" : isMismatch ? "danger" : "warning"}>{result.status}</Badge>}
          <p className="mt-7 border-t border-foreground/10 pt-5 text-xs leading-6 text-muted-foreground">A match proves consistency with the approved build. It does not determine whether the code is safe.</p>
        </aside>
        <div className="inspector-detail">
          <Tabs defaultValue="checks"><TabsList aria-label="Verification details"><TabsTrigger value="checks">Checks</TabsTrigger><TabsTrigger value="records" disabled={!result}>Records</TabsTrigger><TabsTrigger value="environments" disabled={!result}>Environments</TabsTrigger></TabsList>
            <TabsContent value="checks"><div className="mb-5 flex items-center justify-between"><h3 className="text-lg font-medium tracking-tight">Follow the evidence</h3><span className="font-mono text-xs text-muted-foreground">{checks.length} checks</span></div><div className="divide-y divide-foreground/10">{checks.length ? checks.map((check, index) => <CheckRow key={check.id} check={check} index={index} />) : <p className="py-8 text-sm text-muted-foreground">Waiting for the first live read…</p>}</div></TabsContent>
            <TabsContent value="records">{result && <><p className="eyebrow mb-2">Observed on ENS</p><h3 className="mb-7 break-all font-mono text-xl">{result.name}</h3><dl className="space-y-5">
              <DataLine label="Content CID" value={result.cid ? shortCid(result.cid) : "Unavailable"} mono />
              <DataLine label="Owner approval CID" value={result.approvalManifestCid ? shortCid(result.approvalManifestCid) : "Unavailable"} mono />
              <DataLine label="Build manifest CID" value={result.buildManifestCid ? shortCid(result.buildManifestCid) : "Unavailable"} mono />
              <DataLine label="Release / commit" value={result.release ? `#${result.release} · ${result.commit?.slice(0, 10) ?? "commit unavailable"}` : "Not found"} mono />
              <DataLine label="Approver" value={shortAddress(result.approver)} mono /><DataLine label="Approval time" value={formatDate(result.issuedAt)} />
              <DataLine label="Snapshot block" value={result.blockNumber?.toString() ?? "Unavailable"} mono /><DataLine label="Gateway used" value={result.gateway ? new URL(result.gateway).host : "Not fetched"} />
            </dl><div className="record-links">
              {result.siteUrl && <RecordLink href={result.siteUrl}>IPFS site</RecordLink>}{result.buildManifestUrl && <RecordLink href={result.buildManifestUrl}>Build manifest</RecordLink>}{result.approvalManifestUrl && <RecordLink href={result.approvalManifestUrl}>Owner approval</RecordLink>}
              {result.blockNumber !== undefined && <RecordLink href={`https://sepolia.etherscan.io/block/${result.blockNumber}`}>Snapshot block</RecordLink>}<RecordLink href={`https://sepolia.etherscan.io/address/${result.production.resolver ?? deployment.prodResolver}`}>Production resolver</RecordLink>
            </div></>}</TabsContent>
            <TabsContent value="environments">{result && <div className="environment-comparison"><EnvironmentSummary title="Production" detail="Owner-approved environment" environment={result.production} /><ArrowLeftRight className="comparison-arrow" aria-hidden="true" /><EnvironmentSummary title="Preview" detail="Next release candidate" environment={result.preview} /></div>}</TabsContent>
          </Tabs>
        </div>
      </motion.section> : <motion.section key="plan" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reduceMotion ? undefined : { opacity: 0 }} className="verification-plan" aria-labelledby="verification-plan-title"><div><p className="eyebrow">Under the hood</p><h2 id="verification-plan-title" className="mt-3 text-2xl font-medium tracking-tight">Three layers of proof.</h2></div><ol className="verification-phases">{phases.map(({ title, detail, icon: Icon }, index) => <li key={title}><span className="phase-icon"><Icon strokeWidth={1.4} aria-hidden="true" /></span><span className="eyebrow">0{index + 1}</span><h3>{title}</h3><p>{detail}</p></li>)}</ol></motion.section>}
    </AnimatePresence>
  </div>;
}

function EnvironmentSummary({ title, detail, environment }: { title: string; detail: string; environment: Verification["production"] }) {
  return <div className="comparison-environment"><Globe2 className="mb-5 size-7" strokeWidth={1.4} aria-hidden="true" /><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xl font-medium">{title}</h3><Badge>{environment.cid ? "Live" : "Not published"}</Badge></div><p className="mt-2 text-xs text-muted-foreground">{detail}</p><p className="my-6 break-all font-mono text-sm">{environment.name}</p><dl className="space-y-5"><DataLine label="Content CID" value={environment.cid ? shortCid(environment.cid) : "Unavailable"} mono /><DataLine label="Build record" value={environment.buildRecord || "Not set"} mono /></dl><p className="mt-5 text-xs leading-6 text-muted-foreground">{environment.detail}</p></div>;
}
function CheckRow({ check, index }: { check: VerificationCheck; index: number }) {
  const reduceMotion = useReducedMotion();
  const Icon = stateIcon[check.state];
  const label = check.state === "pass" ? "Passed" : check.state === "fail" ? "Failed" : check.state === "info" ? "Info" : "Unavailable";
  return <motion.div initial={reduceMotion ? false : { opacity: 0, x: -5 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: reduceMotion ? 0 : Math.min(index * .05, .4), duration: reduceMotion ? 0 : .22 }} className={`inspection-check inspection-check-${check.state}`}><span className="inspection-check-icon"><Icon className="size-4" aria-hidden="true" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{check.label}</h4><span className="text-xs text-muted-foreground">{label}</span></div><p className="mt-2 break-words text-xs leading-6 text-muted-foreground">{check.detail}</p></div></motion.div>;
}
function DataLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="flex flex-wrap items-start justify-between gap-2 border-b border-foreground/10 pb-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`max-w-full break-all text-right text-xs ${mono ? "font-mono" : ""}`} title={value}>{value}</dd></div>;
}
function RecordLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs font-medium underline decoration-foreground/20 underline-offset-4 hover:decoration-foreground">{children}<ExternalLink className="size-3.5" aria-hidden="true" /></a>;
}
