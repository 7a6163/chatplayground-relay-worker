export interface Env {
  // Vars from wrangler.jsonc
  UPSTREAM_CHAT_URL: string;
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
  UPSTREAM_UPLOAD_URL: string;
  // Clerk frontend API origin — where gateway mode mints session tokens.
  CLERK_FAPI_URL: string;
  // "true" exposes premium models in /v1/models. Unset → non-premium list.
  PREMIUM_MODELS?: string;

  // Gateway auth (optional — set via `wrangler secret put`). When RELAY_API_KEY
  // is set, callers present it instead of a session token and the worker mints
  // its own from the stored Clerk `__client` cookie (session JWTs last 60s, so
  // the JWT itself can't be the secret; the session id is looked up from the
  // cookie, not configured). Unset → passthrough mode (caller sends
  // their own JWT). Secrets, NOT wrangler.jsonc vars (those are plaintext).
  RELAY_API_KEY?: string;
  CLERK_CLIENT_COOKIE?: string;

  // KV binding (optional — without it every cold isolate refetches the model
  // feed, and a discovery failure surfaces as a 503)
  MODEL_CACHE?: KVNamespace;
}

// Hono context variables populated by middleware.
export interface Variables {
  /**
   * Resolves the Clerk session JWT forwarded upstream as `Authorization:
   * Bearer`. A thunk because gateway mode has to mint one, and only the routes
   * that actually talk to upstream should trigger (or be broken by) that.
   */
  sessionToken: () => Promise<string>;
}
