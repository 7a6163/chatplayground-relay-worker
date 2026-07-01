import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types/env";
import { unauthorized } from "../utils/errors";

const CLERK_USER_ID_RE = /^user_[a-zA-Z0-9]+$/;

export const auth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const bearer = c.req
    .header("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  // Gateway mode: if RELAY_API_KEY is configured, the caller must present it and
  // the worker uses its own stored CLERK_USER_ID upstream — the caller never
  // sees (or needs) the real chatplayground identity.
  const gatewayKey = c.env.RELAY_API_KEY;
  if (gatewayKey) {
    if (!bearer || !safeEqual(bearer, gatewayKey)) {
      throw unauthorized("Invalid API key.");
    }
    const clerkId = c.env.CLERK_USER_ID ?? "";
    if (!CLERK_USER_ID_RE.test(clerkId)) {
      // Only reachable by an authorized caller — safe to surface as config error.
      throw unauthorized(
        "Relay misconfigured: CLERK_USER_ID secret is missing or malformed.",
      );
    }
    c.set("clerkUserId", clerkId);
    await next();
    return;
  }

  // Passthrough mode (default): caller supplies their own Clerk ID.
  const fromHeader = c.req.header("x-clerk-user-id")?.trim();
  const id = bearer || fromHeader || "";

  if (!CLERK_USER_ID_RE.test(id)) {
    throw unauthorized(
      "Missing or malformed credentials. Send your chatplayground Clerk user ID (user_...) as `Authorization: Bearer <id>` or `X-Clerk-User-Id: <id>`.",
    );
  }

  c.set("clerkUserId", id);
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
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] as number) ^ (bb[i] as number);
  return diff === 0;
}
