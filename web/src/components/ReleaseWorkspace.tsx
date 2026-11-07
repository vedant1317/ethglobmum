import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, CircleHelp, Clock3, ExternalLink, GitBranch, Globe2, History, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Reveal } from "@/components/Reveal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { CopyValue } from "@/components/CopyValue";
import { StatusPill } from "@/components/StatusPill";
import { deployment } from "@/lib/config";
import { readNameSnapshot } from "@/lib/ens";
import { readReleaseHistory } from "@/lib/history";
import { verifyProject, type VerificationCheck } from "@/lib/verify";
import { formatDate, shortAddress, shortCid, etherscanTx } from "@/lib/utils";

export function ReleaseWorkspace() {
  const prod = useQuery({ queryKey: ["dashboard-prod"], queryFn: () => readNameSnapshot(deployment.prodName), staleTime: 60_000 });
  const preview = useQuery({ queryKey: ["dashboard-preview"], queryFn: () => readNameSnapshot(deployment.previewName), staleTime: 60_000 });
  const verificationQuery = useQuery({ queryKey: ["dashboard-verify"], queryFn: () => verifyProject(deployment.projectName), staleTime: 60_000 });
  const history = useQuery({ queryKey: ["releases"], queryFn: () => readReleaseHistory(), staleTime: 60_000 });
  const verification = verificationQuery.data;
  const cid = verification?.production.cid ?? prod.data?.cid;
  const loading = prod.isLoading || verificationQuery.isLoading;
  const statusCopy = loading ? "Reading the ENS pointer, owner approval, and published files from Sepolia."
    : verification?.status === "MATCH" ? "The production name, owner approval, and fetched files agree."
    : verification?.status === "MISMATCH" ? "One or more checks failed. Open the verifier to review this release."
    : verification?.explanation ?? "A complete release record is not available yet.";

  return <div className="live-release-workspace">
    <Reveal>
      <section aria-labelledby="workspace-title" className="release-workspace">
        <div className="workspace-heading"><div><p className="eyebrow">Release workspace / Sepolia</p><h2 id="workspace-title">What’s live. What’s next.</h2></div><Button variant="outline" size="sm" disabled={prod.isFetching || preview.isFetching || verificationQuery.isFetching || history.isFetching} onClick={() => { void prod.refetch(); void preview.refetch(); void verificationQuery.refetch(); void history.refetch(); }}>Refresh reads</Button></div>
        <Tabs defaultValue="production" className="workspace-body">
          <TabsList aria-label="Release workspace">
            <TabsTrigger value="production"><Globe2 className="size-4" aria-hidden="true" />Production</TabsTrigger>
            <TabsTrigger value="preview"><GitBranch className="size-4" aria-hidden="true" />Preview</TabsTrigger>
            <TabsTrigger value="activity"><History className="size-4" aria-hidden="true" />Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="production">
            <div className="flex flex-wrap items-center justify-between gap-4"><p className="eyebrow">Current production</p><StatusPill status={loading ? "LOADING" : verification?.status ?? "UNAVAILABLE"} /></div>
            <h3 className="workspace-name">{deployment.prodName}</h3>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">{statusCopy}</p>
            {(prod.error || verificationQuery.error) && <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-muted-foreground"><TriangleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />Production data could not be fully loaded: {(verificationQuery.error ?? prod.error) instanceof Error ? (verificationQuery.error ?? prod.error)?.message : "Sepolia read failed"}</p>}
            <div className="workspace-metrics">
              <Metric label="Approved release" value={verification?.release ? `#${verification.release}` : "Not recorded"} detail={verification?.commit ? `Commit ${verification.commit.slice(0, 8)}` : "Approval record"} loading={loading} />
              <div className="min-w-0"><p className="eyebrow">Content CID</p>{loading ? <Skeleton className="mt-3 h-5 w-36" /> : <CopyValue value={cid} className="mt-3 font-mono text-sm text-foreground">{shortCid(cid)}</CopyValue>}<p className="mt-2 text-xs text-muted-foreground">Fingerprint of the published files</p></div>
              <Metric label="Owner approval" value={shortAddress(verification?.approver)} detail="EIP-712 signature" loading={loading} />
            </div>
            <Accordion type="single" collapsible className="mb-6">
              <AccordionItem value="checks"><AccordionTrigger><span className="flex items-center gap-2.5"><ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />What did we check?<span className="text-xs font-normal text-muted-foreground">{verification?.checks.length ?? 0} checks</span></span></AccordionTrigger>
                <AccordionContent>{verificationQuery.isLoading ? <Skeleton className="h-16" /> : verification?.checks.length ? <div className="divide-y divide-foreground/[0.05]">{verification.checks.map(check => <IntegrityRow key={check.id} check={check} />)}</div> : <p className="py-2 leading-6">No checks were returned. Open the verifier to inspect the release.</p>}</AccordionContent>
              </AccordionItem>
            </Accordion>
            <div className="flex flex-wrap items-center gap-3"><Button asChild><Link to="/verify">Open verifier <ArrowUpRight className="size-4" aria-hidden="true" /></Link></Button><Button asChild variant="ghost"><Link to="/releases">Release history <ArrowRight className="size-4" aria-hidden="true" /></Link></Button></div>
          </TabsContent>
          <TabsContent value="preview">
            <div className="flex flex-wrap items-center justify-between gap-4"><p className="eyebrow">Next release candidate</p><StatusPill status={preview.isLoading ? "LOADING" : preview.data?.cid ? "CANDIDATE" : "UNAVAILABLE"} /></div>
            <h3 className="workspace-name">{deployment.previewName}</h3>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">Review the candidate, then approve it from owner controls. Production changes only after the name owner signs.</p>
            {preview.error && <p role="alert" className="mt-4 text-sm text-muted-foreground">Preview could not be loaded: {preview.error instanceof Error ? preview.error.message : "Sepolia read failed"}</p>}
            <div className="workspace-metrics sm:!grid-cols-2">
              <div className="min-w-0"><p className="eyebrow">Candidate CID</p>{preview.isLoading ? <Skeleton className="mt-3 h-5 w-36" /> : <CopyValue value={preview.data?.cid} className="mt-3 font-mono text-sm text-foreground">{shortCid(preview.data?.cid)}</CopyValue>}</div>
              <Metric label="Build manifest" value={shortCid(preview.data?.records["ensure.build"] || preview.data?.records["ensure.manifest"])} detail="Published build record" loading={preview.isLoading} />
            </div>
            <Button asChild><Link to="/promote">Review candidate <ArrowUpRight className="size-4" aria-hidden="true" /></Link></Button>
          </TabsContent>
          <TabsContent value="activity">
            <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="eyebrow">Recorded on-chain</p><h3 className="mt-2 text-2xl font-medium tracking-tight">Recent releases</h3></div><Button asChild variant="ghost" size="sm"><Link to="/releases">View all <ArrowUpRight className="size-4" aria-hidden="true" /></Link></Button></div>
            {history.isLoading ? <div className="mt-6 space-y-4"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : history.error ? <p role="alert" className="py-8 text-sm text-muted-foreground">Release events could not be read: {history.error instanceof Error ? history.error.message : "Sepolia log read failed"}</p> : history.data?.rows.length ? <div className="mt-5 divide-y divide-foreground/[0.08]">{history.data.rows.slice(0, 4).map(row => <div key={row.id} className="flex flex-wrap items-center gap-4 py-5">
              <Clock3 className="size-4 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{row.kind === "rollback" ? "Rollback" : row.kind === "recovered" ? "Recovery" : `Release ${row.release ? `#${row.release}` : "promoted"}`}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{shortCid(row.cid)}</p></div><span className="text-xs text-muted-foreground">{formatDate(row.timestamp)}</span>{row.txHash && etherscanTx(row.txHash) && <a href={etherscanTx(row.txHash)} target="_blank" rel="noreferrer" className="rounded-full p-2 text-muted-foreground hover:text-foreground" aria-label="View release transaction on Etherscan"><ExternalLink className="size-4" /></a>}
            </div>)}</div> : <div className="flex items-start gap-3 py-10 text-sm text-muted-foreground"><Clock3 className="mt-1 size-4 shrink-0" aria-hidden="true" /><div><p>No production release events found.</p><p className="mt-2 text-xs leading-6 text-muted-foreground">{history.data?.note ?? "Releases will appear here when recorded on Sepolia."}</p></div></div>}
          </TabsContent>
        </Tabs>
      </section>
    </Reveal>
  </div>;
}

function Metric({ label, value, detail, loading }: { label: string; value: string; detail: string; loading: boolean }) {
  return <div className="min-w-0"><p className="eyebrow">{label}</p>{loading ? <Skeleton className="mt-3 h-5 w-32" /> : <p className="mt-3 truncate font-mono text-sm text-foreground" title={value}>{value}</p>}<p className="mt-2 text-xs text-muted-foreground">{detail}</p></div>;
}

function IntegrityRow({ check }: { check: VerificationCheck }) {
  const Icon = check.state === "pass" ? Check : check.state === "fail" ? X : CircleHelp;
  const label = check.state === "pass" ? "Passed" : check.state === "fail" ? "Failed" : check.state === "info" ? "Info" : "Unavailable";
  return <div className="flex items-start gap-3 py-4"><Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">{check.label}</p><p className="mt-1 text-xs leading-6 text-muted-foreground">{check.detail}</p></div><span className="pt-0.5 text-xs text-muted-foreground">{label}</span></div>;
}
