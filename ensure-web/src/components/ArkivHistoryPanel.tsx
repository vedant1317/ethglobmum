import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Database, LoaderCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyValue } from "@/components/CopyValue";
import { arkivConfig, arkivEntityUrl, arkivWriterUrl, readArkivHistory, type ReleaseHistoryItem } from "@/lib/arkiv";
import { etherscanTx, formatDate, shortAddress, shortCid } from "@/lib/utils";

type Filter = "ALL" | "CANDIDATE" | "PROMOTED" | "ROLLBACK";
const shortHex = (value?: string) => (value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "—");

/** Release events mirrored to Arkiv by the trusted writer. History only: never used to decide what production serves. */
export function ArkivHistoryPanel() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const history = useQuery({
    queryKey: ["arkiv-history", filter],
    queryFn: () => readArkivHistory(filter === "ALL" ? {} : { eventType: filter }),
    staleTime: 30_000,
    retry: 1,
  });
  const rows = history.data?.entities ?? [];

  return <section className="mt-16 border-t border-foreground/[0.08] pt-10" aria-labelledby="arkiv-title">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <p className="eyebrow">Queryable history / Arkiv Rabdi</p>
        <h2 id="arkiv-title" className="mt-3 flex items-center gap-2 text-2xl font-medium tracking-tight"><Database className="size-5" strokeWidth={1.4} /> Release history mirror</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Each candidate, promotion and rollback is copied to Arkiv after it is checked against Sepolia. This is a searchable record only:
          what production serves is always read from the chain above, never from here.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList aria-label="Filter Arkiv events">
            <TabsTrigger value="ALL">All</TabsTrigger><TabsTrigger value="CANDIDATE">Candidates</TabsTrigger><TabsTrigger value="PROMOTED">Promoted</TabsTrigger><TabsTrigger value="ROLLBACK">Rollbacks</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="icon" variant="ghost" aria-label="Refresh Arkiv history" onClick={() => void history.refetch()} disabled={history.isFetching}>
          {history.isFetching ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>
    </div>

    <div className="mt-8">
      {history.isLoading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Querying Arkiv…</p>
        : history.error ? <div role="alert" className="rounded-2xl border border-dashed border-foreground/20 p-5 text-sm">
          <p className="font-medium">Arkiv could not be read.</p>
          <p className="mt-1 text-muted-foreground">{history.error instanceof Error ? history.error.message.split("\n")[0] : "Request failed"}. This affects history only; Verify and the timeline above read Sepolia directly.</p>
        </div>
        : rows.length ? <ol className="divide-y divide-foreground/[0.07] rounded-2xl border border-foreground/[0.07]">{rows.map((row) => <ArkivRow key={row.entityKey} row={row} />)}</ol>
        : <div className="rounded-2xl border border-dashed border-foreground/20 p-5 text-sm leading-6 text-muted-foreground">
          {filter === "ALL"
            ? <>No release events from the trusted writer yet. Candidates appear after a preview publish is confirmed on Sepolia; promotions and rollbacks appear after the owner's controller transaction is confirmed and mirrored.</>
            : <>No {filter.toLowerCase()} events recorded.</>}
        </div>}
    </div>

    <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
      <span>Schema · {arkivConfig.schema}</span>
      <a className="hover:text-foreground" href={arkivWriterUrl(arkivConfig.writer)} target="_blank" rel="noreferrer">Trusted writer · {shortAddress(arkivConfig.writer)} ↗</a>
      {history.data && <span>Rabdi block {history.data.blockNumber.toString()} · {String(history.data.count ?? rows.length)} event(s)</span>}
    </p>
  </section>;
}

function ArkivRow({ row }: { row: ReleaseHistoryItem }) {
  const variant = row.eventType === "PROMOTED" ? "success" : row.eventType === "ROLLBACK" ? "warning" : "neutral";
  return <li className="grid gap-3 p-4 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-start">
    <div className="space-y-1.5">
      <Badge variant={variant}>{row.eventType}</Badge>
      <div className="text-xs text-muted-foreground">{formatDate(Number(row.recordedAt) * 1000)}</div>
    </div>
    <dl className="grid min-w-0 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
      <Field label="Commit"><span className="font-mono">{row.commitSha.slice(0, 12)}</span></Field>
      <Field label="Site CID"><CopyValue value={row.siteCid} className="font-mono">{shortCid(row.siteCid)}</CopyValue></Field>
      <Field label="Build manifest"><CopyValue value={row.manifestCid} className="font-mono">{shortCid(row.manifestCid)}</CopyValue></Field>
      {row.releaseId && <Field label="Release ID"><CopyValue value={row.releaseId} className="font-mono">{shortHex(row.releaseId)}</CopyValue></Field>}
      {row.fromReleaseId && <Field label="From release"><span className="font-mono">{shortHex(row.fromReleaseId)}</span></Field>}
      {row.sourceBlock !== undefined && <Field label="Sepolia block"><span className="font-mono">{row.sourceBlock.toString()}</span></Field>}
    </dl>
    <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
      {row.sourceTx && <a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" href={etherscanTx(row.sourceTx)} target="_blank" rel="noreferrer">Sepolia tx <ArrowUpRight className="size-3" /></a>}
      <a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" href={arkivEntityUrl(row.entityKey)} target="_blank" rel="noreferrer">Arkiv entity <ArrowUpRight className="size-3" /></a>
      <span className="font-mono text-[10px] text-muted-foreground">expires at block {row.expiresAt.toString()}</span>
    </div>
  </li>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="eyebrow">{label}</dt><dd className="mt-1 min-w-0">{children}</dd></div>;
}
