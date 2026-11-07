import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ensure/arkiv": fileURLToPath(new URL("../arkiv/src", import.meta.url)),
      "@ensure/core": fileURLToPath(new URL("../core/src", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // One copy of each crypto/encoding library, even for code imported from ../core and ../arkiv.
    dedupe: ["viem", "multiformats", "@noble/hashes", "canonicalize"],
  },
  // The verifier (../core) and Arkiv reader (../arkiv) are shared with the CLI and server, not copied.
  server: { port: 5173, strictPort: true, fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  preview: { port: 4173, strictPort: true },
});
