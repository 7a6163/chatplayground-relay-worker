import { defineConfig } from "vitest/config";

// Unit tests here cover pure translation/parsing logic (no Workers runtime
// needed), so they run in the default node environment — fast and dependency
// free. Integration tests that exercise the actual fetch handler with bindings
// should add a separate @cloudflare/vitest-pool-workers project.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
