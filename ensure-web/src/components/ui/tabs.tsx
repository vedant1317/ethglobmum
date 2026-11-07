import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;
const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn("segmented-tabs inline-flex items-center gap-1 rounded-full p-1.5", className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;
const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} className={cn("tab-trigger inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-normal text-muted-foreground transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground", className)} {...props} />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;
const TabsContent = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
export { Tabs, TabsList, TabsTrigger, TabsContent };
