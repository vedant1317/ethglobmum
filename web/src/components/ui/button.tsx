import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-normal transition-all duration-200 active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "button-primary border border-primary bg-primary text-primary-foreground hover:brightness-105",
        secondary: "button-secondary border border-foreground/15 bg-white text-foreground hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
        outline: "border border-foreground/10 bg-transparent text-muted-foreground hover:border-foreground/20 hover:bg-foreground/[0.04]",
        danger: "border border-foreground/20 bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.12]",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-9 px-4 text-xs",
        lg: "h-12 px-6",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
});
Button.displayName = "Button";
