export interface Env {
  // Vars from wrangler.jsonc
  UPSTREAM_CHAT_URL: string;
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
  UPSTREAM_UPLOAD_URL: string;

  // KV bindings (optional — discovery falls back to SEED_MODELS without them)
  MODEL_CACHE?: KVNamespace;
  RATE_LIMIT?: KVNamespace;
}

// Hono context variables populated by middleware.
export interface Variables {
  clerkUserId: string;
}
