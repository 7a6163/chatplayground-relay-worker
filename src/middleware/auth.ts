import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types/env";
import { mintSessionToken } from "../utils/clerk-token";
import { unauthorized } from "../utils/errors";

// Upstream now authenticates with a Clerk session JWT (the old
// `x-clerk-user-id` header 401s on /api/chat/*). Shape check only — upstream
// is the one that verifies the signature.
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export const auth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const bearer = c.req
    .header("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  // Gateway mode: if RELAY_API_KEY is configured, the caller must present it and
  // the worker mints its own session token from the stored Clerk `__client`
  // cookie — the caller never sees (or needs) the real chatplayground identity.
  const gatewayKey = c.env.RELAY_API_KEY;
  if (gatewayKey) {
    if (!bearer || !safeEqual(bearer, gatewayKey)) {
      throw unauthorized("Invalid API key.");
    }
    // Deferred, not minted here: /v1/models and /v1/files need no upstream
    // credential, so they must not pay two Clerk round-trips on a cold isolate
    // — or fail when Clerk does. mintSessionToken caches, so chat pays once.
    c.set("sessionToken", () => mintSessionToken(c.env));
    await next();
    return;
  }

  // Passthrough mode (default): caller supplies their own session JWT, which
  // expires 60 seconds after Clerk issues it — refreshing is the client's job.
  const token = bearer || "";
  if (!JWT_RE.test(token)) {
    throw unauthorized(
      "Missing or malformed credentials. Send a chatplayground Clerk session token (a JWT) as `Authorization: Bearer <jwt>`.",
    );
  }

  c.set("sessionToken", async () => token);
  await next();
});

/**
 * Constant-time comparison of the key bytes — no per-byte short-circuit.
 * (Length mismatch does return early, leaking length only; acceptable for a
 * high-entropy API key, same tradeoff as Node's crypto.timingSafeEqual.)
 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++)
    diff |= (ab[i] as number) ^ (bb[i] as number);
  return diff === 0;
}
