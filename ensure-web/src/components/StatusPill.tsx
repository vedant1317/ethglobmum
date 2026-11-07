import { AlertCircle, Check, CircleHelp, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { VerifyStatus } from "@/lib/verify";

export function StatusPill({ status }: { status: VerifyStatus | "LOADING" | "CANDIDATE" }) {
  if (status === "MATCH") return <Badge variant="success"><Check className="size-3.5" /> Verified</Badge>;
  if (status === "MISMATCH") return <Badge variant="danger"><AlertCircle className="size-3.5" /> Mismatch</Badge>;
  if (status === "CANDIDATE") return <Badge variant="warning"><CircleHelp className="size-3.5" /> Candidate</Badge>;
  if (status === "LOADING") return <Badge variant="neutral"><LoaderCircle className="size-3.5 animate-spin" /> Checking</Badge>;
  return <Badge variant="warning"><CircleHelp className="size-3.5" /> Unavailable</Badge>;
}
