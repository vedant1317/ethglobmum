import type { ReactNode } from "react";

export function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-5 sm:mb-9 sm:flex-row sm:items-end">
    <div className="max-w-4xl">{eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}<h1 className="text-[clamp(2.35rem,4.6vw,3.5rem)] font-medium leading-[1.03] tracking-[-.075em] text-foreground">{title}</h1>{description && <p className="mt-4 max-w-3xl text-[15px] leading-7 text-muted-foreground sm:text-base">{description}</p>}</div>
    {action && <div className="shrink-0">{action}</div>}
  </div>;
}
