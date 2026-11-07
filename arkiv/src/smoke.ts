import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";

export const SmokeEvents = defineSchema("ensure.arkiv-smoke.v1", {
  smokeId: str().indexed(),
  createdAt: u64(),
});
