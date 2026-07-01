export interface Env {
  // Vars from wrangler.jsonc
  UPSTREAM_CHAT_URL: string;
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
  UPSTREAM_UPLOAD_URL: string;

  // Gateway auth (optional — set via `wrangler secret put`). When RELAY_API_KEY
  // is set, callers present it instead of a Clerk ID and the worker uses its own
  // stored CLERK_USER_ID upstream. Unset → passthrough mode (caller sends their
  // own Clerk ID). Secrets, NOT wrangler.jsonc vars (those are plaintext).
  RELAY_API_KEY?: string;
  CLERK_USER_ID?: string;

  // KV bindings (optional — discovery falls back to SEED_MODELS without them)
  MODEL_CACHE?: KVNamespace;
  RATE_LIMIT?: KVNamespace;
}

// Hono context variables populated by middleware.
export interface Variables {
  clerkUserId: string;
}
