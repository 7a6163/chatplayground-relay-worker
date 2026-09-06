import { defineConfig } from "vitest/config";

// Everything runs in the default node environment: the routes are plain Hono
// handlers and nothing in src/ touches a workerd-only API, so `app.request()`
// with a stub env exercises the real thing (see tests/chat.test.ts) and `fetch`
// is the only seam that has to be faked either way. Fast and dependency free.
// A test that genuinely needs workerd — real KV, or a node/workerd API
// divergence like the Headers.getSetCookie one in clerk-token.ts — would mean
// adding @cloudflare/vitest-pool-workers back and giving it its own project.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Type-only modules compile to nothing, so counting them as 0% moves the
      // denominator without saying anything about what is or isn't tested.
      exclude: ["src/types/**", "src/constants/models.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
