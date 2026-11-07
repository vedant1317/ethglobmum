import { Clock3, Fingerprint, Globe2, Layers3 } from "lucide-react";
import type { NameSnapshot } from "@/lib/ens";
import type { VerifyStatus } from "@/lib/verify";
import { shortAddress, shortCid, formatDate } from "@/lib/utils";
import { StatusPill } from "@/components/StatusPill";
import { Card, CardContent } from "@/components/ui/card";
import { CopyValue } from "@/components/CopyValue";
import { Skeleton } from "@/components/ui/skeleton";

function approvalFields(snapshot?: NameSnapshot) {
  if (!snapshot?.records["ensure.approval"]) return {};
  try {
    const envelope = JSON.parse(snapshot.records["ensure.approval"]);
    return { release: envelope.core?.release as string | undefined, approver: envelope.core?.approver as string | undefined, issuedAt: envelope.core?.issuedAt as string | undefined };
  } catch { return {}; }
}

export function EnvironmentCard({ name, environment, snapshot, status, loading }: {
  name: string;
  environment: "Production" | "Preview";
  snapshot?: NameSnapshot;
  status: VerifyStatus | "LOADING" | "CANDIDATE";
  loading?: boolean;
}) {
  const approval = approvalFields(snapshot);
  const isProd = environment === "Production";
  return <Card className="group relative h-full overflow-hidden">
    <div aria-hidden="true" className={`absolute inset-x-0 top-0 h-px ${isProd ? "bg-gradient-to-r from-transparent via-zinc-300/50 to-transparent" : "bg-gradient-to-r from-transparent via-zinc-300/40 to-transparent"}`} />
    <CardContent className="flex h-full flex-col p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`grid size-10 shrink-0 place-items-center rounded-xl border ${isProd ? "border-foreground/15 bg-foreground/[0.07] text-foreground" : "border-foreground/15 bg-foreground/[0.06] text-foreground"}`}><Globe2 aria-hidden="true" className="size-[18px]" /></div>
          <div><p className="eyebrow">{isProd ? "Live environment" : "Build candidate"}</p><h2 className="mt-1 text-sm font-semibold text-foreground">{environment}</h2></div>
        </div>
        {loading ? <Skeleton className="h-6 w-24 rounded-full" /> : <StatusPill status={status} />}
      </div>
      <p className="mt-4 truncate font-mono text-xs text-muted-foreground" title={name}>{name}</p>
      <div className="my-4 h-px bg-foreground/[0.06]" />
      <div className="space-y-3.5">
        <DataRow label="Current release" value={approval.release ? `Release ${approval.release}` : snapshot?.records["ensure.release"] ? shortCid(snapshot.records["ensure.release"]) : "Not numbered"} />
        <div className="flex items-start justify-between gap-3"><span className="text-[11px] text-muted-foreground">Content CID</span>{loading ? <Skeleton className="h-4 w-28" /> : <CopyValue value={snapshot?.cid} className="max-w-[68%] justify-end font-mono text-[10px] text-muted-foreground">{shortCid(snapshot?.cid)}</CopyValue>}</div>
        <DataRow icon={<Fingerprint aria-hidden="true" className="size-3.5" />} label="Approved by" value={shortAddress(approval.approver)} mono />
        <DataRow icon={<Clock3 aria-hidden="true" className="size-3.5" />} label="Approval time" value={formatDate(approval.issuedAt ? Number(approval.issuedAt) * 1000 : undefined)} />
        <DataRow icon={<Layers3 aria-hidden="true" className="size-3.5" />} label="Build manifest" value={snapshot?.records["ensure.build"] || snapshot?.records["ensure.manifest"] || "Not published"} mono truncate />
      </div>
      {!isProd && <div className="mt-auto pt-5"><div className="rounded-xl border border-foreground/[0.1] bg-foreground/[0.035] px-3 py-2.5 text-[10px] leading-5 text-foreground/70">Preview is a candidate. It becomes production only after the name owner approves it.</div></div>}
    </CardContent>
  </Card>;
}

function DataRow({ label, value, icon, mono, truncate }: { label: string; value: string; icon?: React.ReactNode; mono?: boolean; truncate?: boolean }) {
  return <div className="flex items-center justify-between gap-3"><span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">{icon}{label}</span><span className={`min-w-0 text-right text-[11px] text-muted-foreground ${mono ? "font-mono text-[10px]" : ""} ${truncate ? "max-w-[62%] truncate" : ""}`} title={value}>{value}</span></div>;
}
