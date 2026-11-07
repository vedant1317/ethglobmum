import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide", {
  variants: {
    variant: {
      neutral: "border-foreground/10 bg-foreground/[0.045] text-muted-foreground",
      blue: "border-foreground/20 bg-foreground/[0.09] text-muted-foreground",
      success: "border-foreground/15 bg-foreground/[0.07] text-foreground",
      danger: "border-foreground/40 bg-foreground/[0.12] text-foreground",
      warning: "border-dashed border-foreground/25 bg-foreground/[0.035] text-muted-foreground",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
