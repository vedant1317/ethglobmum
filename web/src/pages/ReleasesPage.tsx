import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Clock3, ExternalLink, GitCommitHorizontal, History, LoaderCircle, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Reveal } from "@/components/Reveal";
import { deployment } from "@/lib/config";
import { readReleaseHistory, type ReleaseRow } from "@/lib/history";
import { formatDate, shortAddress, shortCid, etherscanTx } from "@/lib/utils";

type Filter = "all" | "promoted" | "restored";
export function ReleasesPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const history = useQuery({ queryKey: ["releases"], queryFn: readReleaseHistory, refetchInterval: 60_000 });
  const rows = history.data?.rows ?? [];
  const latest = rows[0];
  const visible = rows.filter(row => filter === "all" || (filter === "restored" ? row.kind === "rollback" || row.kind === "recovered" : row.kind !== "rollback" && row.kind !== "recovered"));
  return <div className="history-layout">
    <Reveal><aside className="history-intro">
      <p className="eyebrow">The release trail / Sepolia</p>
      <h1 className="editorial-title">Every release.<br /><em>A <span className="word-cycle word-cycle-late">record.</span></em></h1>
      <p className="editorial-description">Follow the changes to {deployment.prodName}. Every entry comes from a resolver or controller event.</p>
      <div className="history-latest">
        <History className="size-6" strokeWidth={1.4} aria-hidden="true" />
        <p className="eyebrow mt-6">Latest recorded event</p>
        <div className="history-release-number">{history.isLoading ? "…" : latest?.release && !latest.release.startsWith("0x") ? `#${latest.release}` : latest ? "Recorded" : "—"}</div>
        <p className="text-xs leading-6 text-muted-foreground">{latest ? formatDate(latest.timestamp) : "Your release trail starts with the first published event."}</p>
        {latest?.cid && <p className="mt-4 font-mono text-xs text-muted-foreground">{shortCid(latest.cid)}</p>}
      </div>
      <Button asChild variant="ghost" className="mt-4 -ml-4"><Link to="/promote"><RotateCcw className="size-4" />Restore an earlier build <ArrowUpRight className="size-4" /></Link></Button>
    </aside></Reveal>
    <section className="history-stream" aria-label="Release timeline">
      <div className="history-stream-top"><Tabs value={filter} onValueChange={value => setFilter(value as Filter)}><TabsList aria-label="Filter release events"><TabsTrigger value="all">All events</TabsTrigger><TabsTrigger value="promoted">Published</TabsTrigger><TabsTrigger value="restored">Restored</TabsTrigger></TabsList></Tabs><span className="text-xs text-muted-foreground">{history.isFetching ? <LoaderCircle className="size-4 animate-spin" aria-label="Refreshing events" /> : `${visible.length} events`}</span></div>
      {history.isLoading ? <div className="timeline-empty" role="status"><LoaderCircle className="size-6 animate-spin" /><p>Reading the release trail…</p></div> : history.error ? <div className="timeline-empty" role="alert"><Clock3 className="size-8" /><h2>Release events could not be read.</h2><p>{history.error instanceof Error ? history.error.message : "Sepolia read failed"}</p><Button variant="secondary" onClick={() => void history.refetch()}>Try again</Button></div> : visible.length ? <Accordion type="single" collapsible className="release-timeline">{visible.map((row, index) => <ReleaseEvent key={row.id} row={row} newest={row.id === latest?.id} index={index} />)}</Accordion> : <div className="timeline-empty"><History className="size-8" strokeWidth={1.4} /><h2>{rows.length ? "No events in this view." : "The first release starts here."}</h2><p>{rows.length ? "Choose another filter to see the rest of the trail." : history.data?.note ?? "Published releases will appear when recorded on Sepolia."}</p></div>}
      <p className="timeline-source">Source · {history.data?.source ?? "Sepolia contract events"}</p>
    </section>
  </div>;
}

function ReleaseEvent({ row, newest, index }: { row: ReleaseRow; newest: boolean; index: number }) {
  const restore = row.kind === "rollback" || row.kind === "recovered";
  const Icon = restore ? RotateCcw : GitCommitHorizontal;
  const kind = row.kind === "rollback" ? "Rollback" : row.kind === "recovered" ? "Recovery" : "Published";
  return <AccordionItem value={row.id} className="timeline-event">
    <span className={`timeline-node ${newest ? "timeline-node-latest" : ""}`} aria-hidden="true"><Icon className="size-4" /></span>
    <AccordionTrigger className="timeline-event-trigger"><span className="min-w-0"><span className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">{String(index + 1).padStart(2, "0")}</span><span>·</span>{formatDate(row.timestamp)}{newest && <span className="rounded-full bg-accent/50 px-2.5 py-1 text-[10px] font-medium text-foreground">Latest</span>}</span><span className="block text-2xl font-medium tracking-tight">{row.release && !row.release.startsWith("0x") ? `Release #${row.release}` : kind}</span><span className="mt-2 block font-mono text-xs font-normal text-muted-foreground">{row.cid ? shortCid(row.cid) : "CID not recorded"}</span></span><span className="ml-auto hidden text-xs font-normal text-muted-foreground sm:block">{kind}</span></AccordionTrigger>
    <AccordionContent className="timeline-event-details">
      <dl className="event-data-grid">
        <EventDetail label="Site CID" value={row.cid} /><EventDetail label="Source commit" value={row.commit} />
        <EventDetail label="Build manifest" value={row.buildManifestCid} /><EventDetail label="Approval CID" value={row.manifestCid} />
        <EventDetail label="Approver" value={row.approver ? shortAddress(row.approver) : undefined} /><EventDetail label="Block" value={row.block?.toString()} />
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">{row.txHash && etherscanTx(row.txHash) && <Button asChild size="sm" variant="secondary"><a href={etherscanTx(row.txHash)} target="_blank" rel="noreferrer">Transaction <ExternalLink className="size-3.5" /></a></Button>}{row.cid && <Button asChild size="sm" variant="ghost"><a href={`https://ipfs.io/ipfs/${encodeURIComponent(row.cid)}/`} target="_blank" rel="noreferrer">Open IPFS files <ArrowUpRight className="size-3.5" /></a></Button>}</div>
    </AccordionContent>
  </AccordionItem>;
}
function EventDetail({ label, value }: { label: string; value?: string }) {
  return <div className="min-w-0"><dt className="eyebrow">{label}</dt><dd className="mt-2 break-all font-mono text-xs leading-6 text-muted-foreground">{value || "Not recorded in this event"}</dd></div>;
}
