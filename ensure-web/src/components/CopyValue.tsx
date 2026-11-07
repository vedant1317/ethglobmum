import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyValue({ value, children, className }: { value?: string; children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return <div className={cn("flex min-w-0 items-center gap-1", className)}><span className="min-w-0 truncate">{children}</span><Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" onClick={() => void copy()} disabled={!value} aria-label="Copy value">{copied ? <Check className="size-3.5 text-muted-foreground" /> : <Copy className="size-3.5" />}</Button></div>;
}
