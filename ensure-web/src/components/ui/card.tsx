import * as React from "react";
import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("panel-surface rounded-[28px] border border-foreground/[0.04] bg-card", className)} {...props} />
));
Card.displayName = "Card";

export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex flex-col gap-1.5 p-5 sm:p-6", className)} {...props} />;
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className={cn("text-base font-semibold tracking-tight text-foreground", className)} {...props} />;
export const CardDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p className={cn("text-sm leading-6 text-muted-foreground", className)} {...props} />;
export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("px-5 pb-5 sm:px-6 sm:pb-6", className)} {...props} />;
