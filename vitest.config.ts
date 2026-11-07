import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["core/test/**/*.test.ts", "server/test/**/*.test.ts", "tools/ensure-sepolia/test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 300_000 },
});
