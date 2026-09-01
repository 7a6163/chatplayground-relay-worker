import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, safeEqual } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/error-handler";
import { resetSessionTokenCache } from "../src/utils/clerk-token";

// Structurally valid JWT (three base64url segments) — the relay only shape-checks.
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2ln-bmF0dXJl";

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("sk-relay-abc123", "sk-relay-abc123")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(safeEqual("sk-relay-abc123", "sk-relay-abc124")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(safeEqual("short", "longer-key")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "x")).toBe(false);
  });
});

/** Clerk FAPI double: /v1/client resolves a session, /tokens mints a JWT. */
function clerkStub(url: string): Response {
  return url.endsWith("/v1/client")
    ? Response.json({
        response: {
          last_active_session_id: "sess_discovered",
          sessions: [{ id: "sess_discovered", status: "active" }],
        },
      })
    : Response.json({ object: "token", jwt: "minted.jwt.sig" });
}

// biome-ignore lint/suspicious/noExplicitAny: minimal test env stub
function call(env: any, headers: Record<string, string>) {
  const app = new Hono<any>();
  app.onError(errorHandler);
  app.use("*", auth);
  app.get("/", async (c) =>
    c.json({ sessionToken: await c.get("sessionToken")() }),
  );
  return app.request("/", { headers }, env);
}

describe("auth — gateway mode (RELAY_API_KEY set)", () => {
  const env = {
    RELAY_API_KEY: "sk-relay-xyz",
    CLERK_CLIENT_COOKIE: "client-cookie-value",
    CLERK_FAPI_URL: "https://clerk.example.test",
    UPSTREAM_ORIGIN: "https://web.example.test",
    UPSTREAM_REFERER: "https://web.example.test/",
  };

  beforeEach(() => {
    resetSessionTokenCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => clerkStub(String(input)),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("accepts the correct key, discovers the session, and mints a token", async () => {
    const res = await call(env, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: "minted.jwt.sig" });

    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls[0]).toContain("/v1/client");
    expect(urls[1]).toContain("/v1/client/sessions/sess_discovered/tokens");

    const [, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).cookie).toBe(
      "__client=client-cookie-value",
    );
  });

  it("prefers an active session over last_active_session_id", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/client")
        ? Response.json({
            response: {
              last_active_session_id: "sess_stale",
              sessions: [
                { id: "sess_stale", status: "expired" },
                { id: "sess_live", status: "active" },
              ],
            },
          })
        : Response.json({ jwt: "minted.jwt.sig" }),
    );
    await call(env, { authorization: "Bearer sk-relay-xyz" });
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      "/sessions/sess_live/tokens",
    );
  });

  it("401s when the cookie resolves to no session (Clerk returns an empty client)", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ response: { sessions: [] } }),
    );
    const res = await call(env, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(401);
  });

  it("reuses the token and the session id across requests", async () => {
    await call(env, { authorization: "Bearer sk-relay-xyz" });
    await call(env, { authorization: "Bearer sk-relay-xyz" });
    // One /v1/client + one mint, not two of each.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("rejects a wrong key without touching Clerk", async () => {
    const res = await call(env, { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a missing key", async () => {
    const res = await call(env, {});
    expect(res.status).toBe(401);
  });

  it("ignores a caller-supplied JWT in gateway mode", async () => {
    const res = await call(env, {
      authorization: "Bearer sk-relay-xyz",
      "x-clerk-user-id": "user_attacker",
    });
    expect(await res.json()).toEqual({ sessionToken: "minted.jwt.sig" });
  });

  it("401s when the stored Clerk cookie is missing", async () => {
    const res = await call(
      { RELAY_API_KEY: "sk-relay-xyz" },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(401);
  });

  it("surfaces an expired __client cookie as 401 from Clerk", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));
    const res = await call(env, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(401);
  });
});

describe("auth — gateway mode cookie rotation", () => {
  const base = {
    RELAY_API_KEY: "sk-relay-xyz",
    CLERK_CLIENT_COOKIE: "secret-cookie",
    CLERK_FAPI_URL: "https://clerk.example.test",
    UPSTREAM_ORIGIN: "https://web.example.test",
    UPSTREAM_REFERER: "https://web.example.test/",
  };

  function kv(stored: string | null = null) {
    return {
      get: vi.fn().mockResolvedValue(stored),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  }

  function tokenResponse(setCookie?: string) {
    return new Response(JSON.stringify({ jwt: "minted.jwt.sig" }), {
      headers: setCookie
        ? { "content-type": "application/json", "set-cookie": setCookie }
        : { "content-type": "application/json" },
    });
  }

  /** Session discovery always succeeds here; these tests are about the cookie. */
  function mintOnly(mint: (n: number) => Response) {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) =>
        String(input).endsWith("/v1/client")
          ? Response.json({ response: { last_active_session_id: "sess_x" } })
          : mint(n++),
    );
  }

  function cookieOf(callIndex: number): string {
    const [, init] = vi.mocked(fetch).mock.calls[callIndex] as [
      string,
      RequestInit,
    ];
    return (init.headers as Record<string, string>).cookie as string;
  }

  beforeEach(() => resetSessionTokenCache());
  afterEach(() => vi.restoreAllMocks());

  it("persists a rotated cookie to KV", async () => {
    const MODEL_CACHE = kv();
    mintOnly(() => tokenResponse("__client=rotated-value; Path=/; HttpOnly"));

    const res = await call(
      { ...base, MODEL_CACHE },
      {
        authorization: "Bearer sk-relay-xyz",
      },
    );
    expect(res.status).toBe(200);
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "rotated-value",
    );
  });

  it("ignores a sign-out clear (empty value) rather than storing it", async () => {
    const MODEL_CACHE = kv();
    mintOnly(() => tokenResponse("__client=; Max-Age=0; Path=/"));

    await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(MODEL_CACHE.put).not.toHaveBeenCalled();
  });

  it("prefers the KV cookie over the secret", async () => {
    const MODEL_CACHE = kv("rotated-value");
    mintOnly(() => tokenResponse());

    await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(cookieOf(0)).toBe("__client=rotated-value");
  });

  it("drops a stale KV cookie and retries with the secret", async () => {
    const MODEL_CACHE = kv("dead-value");
    mintOnly((n) =>
      n === 0 ? new Response("", { status: 401 }) : tokenResponse(),
    );

    const res = await call(
      { ...base, MODEL_CACHE },
      {
        authorization: "Bearer sk-relay-xyz",
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: "minted.jwt.sig" });
    expect(MODEL_CACHE.delete).toHaveBeenCalledWith("clerk:client_cookie");
    // Discovery, dead mint, then discovery + mint again on the secret.
    expect(cookieOf(0)).toBe("__client=dead-value");
    expect(cookieOf(3)).toBe("__client=secret-cookie");
  });

  it("401s when both the KV copy and the secret are dead", async () => {
    const MODEL_CACHE = kv("dead-value");
    mintOnly(() => new Response("", { status: 401 }));

    const res = await call(
      { ...base, MODEL_CACHE },
      {
        authorization: "Bearer sk-relay-xyz",
      },
    );
    expect(res.status).toBe(401);
    expect(MODEL_CACHE.delete).toHaveBeenCalledWith("clerk:client_cookie");
  });

  it("works without a KV binding (rotation just isn't persisted)", async () => {
    mintOnly(() => tokenResponse("__client=rotated-value; Path=/"));
    const res = await call(base, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(200);
  });
});

describe("auth — gateway mode failure handling", () => {
  const base = {
    RELAY_API_KEY: "sk-relay-xyz",
    CLERK_CLIENT_COOKIE: "secret-cookie",
    CLERK_FAPI_URL: "https://clerk.example.test",
    UPSTREAM_ORIGIN: "https://web.example.test",
    UPSTREAM_REFERER: "https://web.example.test/",
  };

  function kv(stored: string | null = null) {
    return {
      get: vi.fn().mockResolvedValue(stored),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => resetSessionTokenCache());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the KV cookie when Clerk 500s — it is the only live credential", async () => {
    const MODEL_CACHE = kv("rotated-value");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/v1/client")
        ? Response.json({ response: { last_active_session_id: "sess_x" } })
        : new Response("", { status: 500 }),
    );

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(502); // upstreamError maps 500 → 502
    expect(MODEL_CACHE.delete).not.toHaveBeenCalled();
  });

  it("re-resolves a session id that went stale between requests", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/v1/client")
        ? Response.json({ response: { last_active_session_id: "sess_first" } })
        : Response.json({ jwt: "minted.jwt.sig" }),
    );
    await call(base, { authorization: "Bearer sk-relay-xyz" }); // caches sess_first
    // Let the 45s token cache lapse while the session id stays cached.
    vi.setSystemTime(Date.now() + 46_000);

    // Same isolate, but chatplayground signed out and back in: the cached id 401s.
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({
          response: { last_active_session_id: "sess_second" },
        });
      }
      return url.includes("sess_first")
        ? new Response("", { status: 401 })
        : Response.json({ jwt: "second.jwt.sig" });
    });

    const res = await call(base, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: "second.jwt.sig" });
  });

  it("carries a cookie rotated by the session lookup into the mint and KV", async () => {
    const MODEL_CACHE = kv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/v1/client")
        ? Response.json(
            { response: { last_active_session_id: "sess_x" } },
            { headers: { "set-cookie": "__client=rotated-on-lookup; Path=/" } },
          )
        : Response.json({ jwt: "minted.jwt.sig" }),
    );

    await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    const [, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).cookie).toBe(
      "__client=rotated-on-lookup",
    );
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "rotated-on-lookup",
    );
  });

  it("never touches Clerk for a route that doesn't need upstream auth", async () => {
    vi.spyOn(globalThis, "fetch");
    // /v1/models and /v1/files never call the thunk.
    // biome-ignore lint/suspicious/noExplicitAny: minimal test env stub
    const app = new Hono<any>();
    app.onError(errorHandler);
    app.use("*", auth);
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request(
      "/",
      { headers: { authorization: "Bearer sk-relay-xyz" } },
      base,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("auth — passthrough mode (no RELAY_API_KEY)", () => {
  it("accepts a session JWT as Bearer", async () => {
    const res = await call({}, { authorization: `Bearer ${JWT}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: JWT });
  });

  it("rejects the retired Clerk user id", async () => {
    const res = await call({}, { authorization: "Bearer user_caller99" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const res = await call({}, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("empty RELAY_API_KEY falls back to passthrough (not an open gateway)", async () => {
    const res = await call(
      { RELAY_API_KEY: "" },
      {
        authorization: `Bearer ${JWT}`,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: JWT });
  });
});
