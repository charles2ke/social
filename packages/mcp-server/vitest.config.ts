import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace packages from source so tests do not require a build.
export default defineConfig({
  resolve: {
    alias: {
      "@social/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
