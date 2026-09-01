import { CLERK_TOKEN_TIMEOUT } from "../constants/timeouts";
import type { Env } from "../types/env";
import { unauthorized, upstreamError } from "./errors";

// A Clerk session token lives 60 seconds, so gateway mode cannot store one as a
// secret. It stores the long-lived `__client` cookie instead and mints a fresh
// session token from Clerk's frontend API, exactly as the web app does.
//
// ponytail: per-isolate value cache, no promise dedupe — concurrent cold
// requests may mint twice (Clerk allows it). Add dedupe only if it shows up.
let cached: { jwt: string; until: number } | null = null;

// Resolved once per isolate and kept until an attempt fails, so the session
// lookup costs one request on cold start rather than one per mint.
let cachedSessionId: string | null = null;

// Where a rotated cookie is kept. The `__client` JWT carries no `exp` — only an
// `id` + `rotating_token` — so it dies by rotation, not by expiry, and the
// rotated value has to outlive the isolate to be worth anything.
const COOKIE_KEY = "clerk:client_cookie";

export async function mintSessionToken(env: Env): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.jwt;

  const secretCookie = env.CLERK_CLIENT_COOKIE;
  if (!secretCookie) {
    // Only reachable by an authorized caller — safe to surface as config error.
    throw unauthorized(
      "Relay misconfigured: CLERK_CLIENT_COOKIE secret is missing.",
    );
  }

  // A rotated cookie in KV supersedes the secret: after a rotation it is the
  // only live credential, the secret being dead by definition. So drop it only
  // when Clerk actually rejects it — a 5xx or 429 must leave it alone.
  const stored = await env.MODEL_CACHE?.get(COOKIE_KEY);
  let result = await attempt(env, stored ?? secretCookie);
  if (!result.ok && stored && isAuthFailure(result.status)) {
    await env.MODEL_CACHE?.delete(COOKIE_KEY);
    result = await attempt(env, secretCookie);
  }

  if (!result.ok) {
    throw upstreamError(
      result.status,
      `Clerk token refresh failed (${result.status}). The __client cookie has likely been rotated or revoked — re-capture it and re-run \`wrangler secret put CLERK_CLIENT_COOKIE\`.`,
    );
  }

  // Persist a rotated cookie so the next isolate authenticates with the live
  // value, not the dead secret. Without a KV binding rotation simply breaks
  // gateway mode until you re-capture the cookie by hand.
  if (result.rotated) await env.MODEL_CACHE?.put(COOKIE_KEY, result.rotated);

  // Refresh 15s before the 60s expiry so an in-flight request never carries a
  // token that dies mid-hop.
  cached = { jwt: result.jwt, until: Date.now() + 45_000 };
  return result.jwt;
}

type Attempt =
  | { ok: true; jwt: string; rotated: string | null }
  | { ok: false; status: number };

const isAuthFailure = (status: number) => status === 401 || status === 403;

async function attempt(env: Env, cookie: string): Promise<Attempt> {
  if (cachedSessionId) {
    const result = await mint(env, cachedSessionId, cookie, null);
    // A cached session id outlives the session it names — the account can sign
    // out and back in between requests. Re-resolve before blaming the cookie.
    if (result.ok || !isAuthFailure(result.status)) return result;
    cachedSessionId = null;
  }

  const client = await clerk(env, "/v1/client", cookie, "GET");
  if (!client.ok) return { ok: false, status: client.status };

  // Clerk can rotate `__client` on this handshake-shaped call too; if it does,
  // the replacement is what the mint — and KV — have to carry from here on.
  const rotated = rotatedCookie(client.headers);
  const sessionId = await sessionIdOf(client);
  // A cookie Clerk no longer honours yields an empty client, not an error, so
  // "no session" is this call's version of a 401.
  if (!sessionId) return { ok: false, status: 401 };

  const result = await mint(env, sessionId, rotated ?? cookie, rotated);
  if (result.ok) cachedSessionId = sessionId;
  return result;
}

async function mint(
  env: Env,
  sessionId: string,
  cookie: string,
  rotatedSoFar: string | null,
): Promise<Attempt> {
  // The browser also sends `?__clerk_api_version&_clerk_js_version` and an
  // `organization_id=&token=<previous jwt>` body; verified live that Clerk mints
  // fine without any of them, so we don't carry a js version that will rot.
  const res = await clerk(
    env,
    `/v1/client/sessions/${sessionId}/tokens`,
    cookie,
    "POST",
  );
  const body = res.ok
    ? ((await res.json().catch(() => null)) as { jwt?: string } | null)
    : null;
  if (!body?.jwt) return { ok: false, status: res.status };

  return {
    ok: true,
    jwt: body.jwt,
    rotated: rotatedCookie(res.headers) ?? rotatedSoFar,
  };
}

interface ClerkClient {
  last_active_session_id?: string | null;
  sessions?: { id: string; status: string }[];
}

/**
 * The `__client` cookie carries only `id` + `rotating_token` — the session id
 * is not in it and cannot be decoded out, so ask Clerk which session the cookie
 * currently owns. Doing this instead of storing a `sess_...` secret also means
 * a new session on the same client is picked up on its own.
 */
async function sessionIdOf(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as {
    response?: ClerkClient;
  } | null;
  const client = body?.response ?? (body as ClerkClient | null);
  const active = client?.sessions?.find((s) => s.status === "active");
  return active?.id ?? client?.last_active_session_id ?? null;
}

function clerk(
  env: Env,
  path: string,
  cookie: string,
  method: "GET" | "POST",
): Promise<Response> {
  // ponytail: a network-level failure (timeout, DNS) throws out of here and
  // surfaces as 500, matching how routes/chat.ts treats its own upstream fetch.
  return fetch(`${env.CLERK_FAPI_URL}${path}`, {
    method,
    headers: {
      cookie: `__client=${cookie}`,
      origin: env.UPSTREAM_ORIGIN,
      referer: env.UPSTREAM_REFERER,
    },
    signal: AbortSignal.timeout(CLERK_TOKEN_TIMEOUT),
  });
}

// Workers' Headers exposes getAll("set-cookie"); undici (vitest) exposes
// getSetCookie(). get() is the last resort — it may join or truncate the list.
type CookieHeaders = Headers & {
  getSetCookie?: () => string[];
  getAll?: (name: string) => string[];
};

function rotatedCookie(headers: Headers): string | null {
  const h = headers as CookieHeaders;
  const lines = h.getSetCookie?.() ??
    h.getAll?.("set-cookie") ?? [headers.get("set-cookie") ?? ""];
  for (const line of lines) {
    // `__client_uat` is a different (public, non-credential) cookie — the `=`
    // anchor keeps it out.
    const value = /^__client=([^;]+)/.exec(line)?.[1];
    // Clerk clears the cookie with an empty value on sign-out — not a rotation.
    if (value) return value;
  }
  return null;
}

/** Test seam — the module caches are per-isolate and otherwise invisible. */
export function resetSessionTokenCache(): void {
  cached = null;
  cachedSessionId = null;
}
