export interface Env {
  // Vars from wrangler.jsonc
  UPSTREAM_CHAT_URL: string;
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
  UPSTREAM_UPLOAD_URL: string;
  // "true" exposes premium models in /v1/models. Unset → non-premium list.
  PREMIUM_MODELS?: string;

  // Gateway auth (optional — set via `wrangler secret put`). When RELAY_API_KEY
  // is set, callers present it instead of a Clerk ID and the worker uses its own
  // stored CLERK_USER_ID upstream. Unset → passthrough mode (caller sends their
  // own Clerk ID). Secrets, NOT wrangler.jsonc vars (those are plaintext).
  RELAY_API_KEY?: string;
  CLERK_USER_ID?: string;

  // KV binding (optional — without it every cold isolate refetches the model
  // feed, and a discovery failure surfaces as a 503)
  MODEL_CACHE?: KVNamespace;
}

// Hono context variables populated by middleware.
export interface Variables {
  clerkUserId: string;
}
