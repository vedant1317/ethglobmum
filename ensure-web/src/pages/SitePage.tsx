import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, LoaderCircle } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyValue } from "@/components/CopyValue";
import { SectionHeading } from "@/components/SectionHeading";
import { ApiError, getSite, getSiteIpns } from "@/lib/api";
import { formatDate, shortAddress, shortCid } from "@/lib/utils";

export function SitePage() {
  const { domain = "" } = useParams();
  const site = useQuery({ queryKey: ["site", domain], queryFn: () => getSite(domain), enabled: Boolean(domain) });
  const ipns = useQuery({ queryKey: ["site-ipns", domain], queryFn: () => getSiteIpns(domain), enabled: Boolean(domain), retry: false });
  const latest = site.data?.latest;

  return <div>
    <Button asChild variant="ghost" size="sm" className="-ml-4 mb-4"><Link to="/dashboard"><ArrowLeft className="size-4" /> Sites</Link></Button>
    <SectionHeading eyebrow="Deploy history / DeployRegistry" title={domain} description={site.data ? `${site.data.count} deploy${site.data.count === 1 ? "" : "s"} recorded on Sepolia.` : undefined}
      action={latest && <Button asChild variant="secondary"><a href={latest.url} target="_blank" rel="noreferrer">Open latest <ArrowUpRight className="size-4" /></a></Button>} />

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card><CardHeader><CardTitle>Deploys</CardTitle></CardHeader><CardContent>
        {site.isLoading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Reading history…</p>
          : site.error ? <p role="alert" className="text-sm text-muted-foreground">{(site.error as Error).message}</p>
          : site.data?.history.length ? <ol className="divide-y divide-foreground/[0.07]">{[...site.data.history].sort((a, b) => b.timestamp - a.timestamp).map((d, i) => <li key={`${d.cid}-${d.timestamp}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{formatDate(d.timestamp * 1000)}<Badge variant={d.env === "production" ? "success" : "neutral"}>{d.env}</Badge>{i === 0 && <Badge variant="blue">Latest</Badge>}</div>
              <CopyValue value={d.cid} className="mt-1 font-mono text-xs">{shortCid(d.cid)}</CopyValue>
              {d.meta && <p className="truncate text-xs text-muted-foreground" title={d.meta}>{d.meta}</p>}
            </div>
            <div className="flex items-center gap-2"><span className="font-mono text-[11px] text-muted-foreground">{shortAddress(d.deployer)}</span><Button asChild size="sm" variant="ghost"><a href={d.url} target="_blank" rel="noreferrer">Files <ArrowUpRight className="size-3.5" /></a></Button></div>
          </li>)}</ol>
          : <p className="text-sm text-muted-foreground">No deploys recorded for this domain.</p>}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>IPNS pointer</CardTitle></CardHeader><CardContent>
        {ipns.isLoading ? <p role="status" className="text-sm text-muted-foreground">Reading…</p>
          : ipns.error ? <p className="text-sm text-muted-foreground">{ipns.error instanceof ApiError && ipns.error.status === 404 ? "This domain is not registered in IPNSRegistry." : (ipns.error as Error).message}</p>
          : ipns.data && <dl className="space-y-4">
            <Row label="Status"><Badge variant={ipns.data.active ? "success" : "warning"}>{ipns.data.active ? "Active" : "Inactive"}</Badge></Row>
            <Row label="Key"><CopyValue value={ipns.data.ipnsKey} className="font-mono text-xs">{ipns.data.ipnsKey}</CopyValue></Row>
            <Row label="Latest CID"><CopyValue value={ipns.data.latestCid} className="font-mono text-xs">{shortCid(ipns.data.latestCid)}</CopyValue></Row>
            <Row label="Sequence · updated"><span className="text-xs">#{ipns.data.latestSeq} · {formatDate(ipns.data.updatedAt * 1000)}</span></Row>
            {ipns.data.gateways.length > 0 && <Row label="Gateways"><ul className="space-y-1 font-mono text-[11px] text-muted-foreground">{ipns.data.gateways.map((g) => <li key={g} className="truncate">{g}</li>)}</ul></Row>}
          </dl>}
      </CardContent></Card>
    </div>
  </div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="eyebrow">{label}</dt><dd className="mt-1.5 min-w-0">{children}</dd></div>;
}
