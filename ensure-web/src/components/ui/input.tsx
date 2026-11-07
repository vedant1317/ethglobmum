import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("inset-input h-12 w-full rounded-2xl border border-foreground/[0.03] bg-input px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/50 focus:ring-2 focus:ring-ring/15 disabled:opacity-50", className)} {...props} />
));
Input.displayName = "Input";
