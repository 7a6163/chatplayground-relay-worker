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

// oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
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

  it("keeps the KV copy when the secret is dead too — deleting gains nothing", async () => {
    const MODEL_CACHE = kv("dead-value");
    mintOnly(() => new Response("", { status: 401 }));

    const res = await call(
      { ...base, MODEL_CACHE },
      {
        authorization: "Bearer sk-relay-xyz",
      },
    );
    expect(res.status).toBe(401);
    expect(MODEL_CACHE.delete).not.toHaveBeenCalled();
  });

  it("works without a KV binding (rotation just isn't persisted)", async () => {
    mintOnly(() => tokenResponse("__client=rotated-value; Path=/"));
    const res = await call(base, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(200);
  });
});

// workerd's Headers exposes getAll("set-cookie") and no getSetCookie; undici
// (what these tests run on) is the other way round. So the accessor that
// actually ships is never reached by a real Response here — these stub the
// shape to cover the feature detection rather than workerd itself.
describe("auth — cookie rotation under a workerd-shaped Headers", () => {
  const base = {
    RELAY_API_KEY: "sk-relay-xyz",
    CLERK_CLIENT_COOKIE: "secret-cookie",
    CLERK_FAPI_URL: "https://clerk.example.test",
    UPSTREAM_ORIGIN: "https://web.example.test",
    UPSTREAM_REFERER: "https://web.example.test/",
  };

  const kv = () => ({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  });

  /** Response-shaped stub whose headers expose only the given accessors. */
  function serve(headers: (setCookie: string) => Record<string, unknown>) {
    const reply = (body: unknown, setCookie: string) =>
      ({
        ok: true,
        status: 200,
        headers: headers(setCookie),
        json: async () => body,
      }) as unknown as Response;

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) =>
        String(input).endsWith("/v1/client")
          ? reply(
              { response: { last_active_session_id: "sess_x" } },
              "__client=rotated-value; Path=/; HttpOnly",
            )
          : reply({ jwt: "minted.jwt.sig" }, ""),
    );
  }

  beforeEach(() => resetSessionTokenCache());
  afterEach(() => vi.restoreAllMocks());

  it("reads the rotation from getAll when getSetCookie is absent", async () => {
    const MODEL_CACHE = kv();
    serve((sc) => ({
      getAll: (name: string) => (name === "set-cookie" && sc ? [sc] : []),
      get: () => null,
    }));

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(200);
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "rotated-value",
    );
  });

  it("falls back to get() when neither list accessor exists", async () => {
    const MODEL_CACHE = kv();
    serve((sc) => ({
      get: (name: string) => (name === "set-cookie" && sc ? sc : null),
    }));

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(200);
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "rotated-value",
    );
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

  it("persists a lookup rotation even when the mint then fails", async () => {
    const MODEL_CACHE = kv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/v1/client")
        ? Response.json(
            { response: { last_active_session_id: "sess_x" } },
            { headers: { "set-cookie": "__client=rotated-on-lookup; Path=/" } },
          )
        : new Response("", { status: 500 }),
    );

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(502);
    // Clerk already killed the old cookie when it issued this one; dropping it
    // on the failure path would leave gateway mode with no live credential.
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "rotated-on-lookup",
    );
  });

  it("re-resolves a session id Clerk 404s on, not just one it 401s on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/v1/client")
        ? Response.json({ response: { last_active_session_id: "sess_first" } })
        : Response.json({ jwt: "minted.jwt.sig" }),
    );
    await call(base, { authorization: "Bearer sk-relay-xyz" }); // caches sess_first
    vi.setSystemTime(Date.now() + 46_000);

    // Clerk answers 404 for a session id it no longer knows — not an auth
    // failure, so treating only 401/403 as re-resolvable stranded the isolate.
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({
          response: { last_active_session_id: "sess_second" },
        });
      }
      return url.includes("sess_first")
        ? new Response("", { status: 404 })
        : Response.json({ jwt: "second.jwt.sig" });
    });

    const res = await call(base, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: "second.jwt.sig" });
  });

  it("treats a 2xx mint with no jwt as a gateway failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/v1/client")
        ? Response.json({ response: { last_active_session_id: "sess_x" } })
        : Response.json({ object: "token" }),
    );

    const res = await call(base, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "upstream_502",
    );
  });

  it("never touches Clerk for a route that doesn't need upstream auth", async () => {
    vi.spyOn(globalThis, "fetch");
    // /v1/models and /v1/files never call the thunk.
    // oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
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

// The rotations that actually kill gateway mode are handed to a browser, not
// to us, so the worker signs in for itself rather than watching Set-Cookie.
describe("auth — gateway mode self-heals by signing in", () => {
  const base = {
    RELAY_API_KEY: "sk-relay-xyz",
    CLERK_FAPI_URL: "https://clerk.example.test",
    UPSTREAM_ORIGIN: "https://web.example.test",
    UPSTREAM_REFERER: "https://web.example.test/",
    CLERK_EMAIL: "relay@example.test",
    CLERK_PASSWORD: "hunter2",
  };

  const kv = (stored: string | null = null) => ({
    get: vi.fn().mockResolvedValue(stored),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  });

  const json = (body: unknown, setCookie?: string) =>
    new Response(JSON.stringify(body), {
      headers: setCookie
        ? { "content-type": "application/json", "set-cookie": setCookie }
        : { "content-type": "application/json" },
    });

  /** Clerk where every configured cookie is dead and only sign-in works. */
  function clerkThatOnlyAcceptsSignIn(tokenStatus = 200) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const cookie = (init?.headers as Record<string, string> | undefined)
          ?.cookie;

        if (url.endsWith("/v1/client")) {
          // No cookie header at all is the sign-in bootstrap.
          if (!cookie) {
            return json(
              { response: { sessions: [] } },
              "__client=boot; Path=/",
            );
          }
          return cookie === "__client=fresh-cookie"
            ? json({ response: { last_active_session_id: "sess_new" } })
            : json({ response: { sessions: [] } });
        }
        if (url.endsWith("/sign_ins"))
          return json({ response: { id: "sia_1" } });
        if (url.includes("attempt_first_factor")) {
          return json(
            { response: { status: "complete" } },
            "__client=fresh-cookie; Path=/; HttpOnly",
          );
        }
        return tokenStatus === 200
          ? json({ jwt: "minted.jwt.sig" })
          : new Response("", { status: tokenStatus });
      },
    );
  }

  beforeEach(() => resetSessionTokenCache());
  afterEach(() => vi.restoreAllMocks());

  it("signs in when no cookie is configured at all", async () => {
    const MODEL_CACHE = kv();
    clerkThatOnlyAcceptsSignIn();

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: "minted.jwt.sig" });
    // The cookie it signed in for is the one worth keeping.
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "fresh-cookie",
    );
  });

  it("signs in after both the KV copy and the secret are dead", async () => {
    const MODEL_CACHE = kv("dead-kv-value");
    clerkThatOnlyAcceptsSignIn();

    const res = await call(
      { ...base, CLERK_CLIENT_COOKIE: "dead-secret", MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(200);
    expect(MODEL_CACHE.put).toHaveBeenCalledWith(
      "clerk:client_cookie",
      "fresh-cookie",
    );
  });

  it("sends identifier then password, as two separate calls", async () => {
    clerkThatOnlyAcceptsSignIn();
    await call(base, { authorization: "Bearer sk-relay-xyz" });

    const calls = vi
      .mocked(fetch)
      .mock.calls.map(([u, i]) => [
        String(u),
        (i as RequestInit | undefined)?.body,
      ]);
    const start = calls.find(([u]) => String(u).endsWith("/sign_ins"));
    const attempt = calls.find(([u]) => String(u).includes("attempt_first"));
    expect(start?.[1]).toBe("locale=en-US&identifier=relay%40example.test");
    expect(attempt?.[1]).toBe("strategy=password&password=hunter2");
    // The bootstrap must not carry a cookie, or Clerk reuses a cleared one.
    const boot = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect((boot.headers as Record<string, string>).cookie).toBeUndefined();
  });

  it("does not burn a login when Clerk is merely down", async () => {
    const MODEL_CACHE = kv("some-value");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );

    const res = await call(
      { ...base, CLERK_CLIENT_COOKIE: "secret", MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(502);
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("sign_ins"))).toBe(false);
    expect(MODEL_CACHE.delete).not.toHaveBeenCalled();
  });

  it("leaves the old behaviour alone when no credentials are configured", async () => {
    clerkThatOnlyAcceptsSignIn();
    const res = await call(
      {
        RELAY_API_KEY: "sk-relay-xyz",
        CLERK_CLIENT_COOKIE: "dead-secret",
        CLERK_FAPI_URL: "https://clerk.example.test",
        UPSTREAM_ORIGIN: "https://web.example.test",
        UPSTREAM_REFERER: "https://web.example.test/",
      },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(401);
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("sign_ins"))).toBe(false);
  });

  it("surfaces the original auth failure when the password is wrong", async () => {
    const MODEL_CACHE = kv();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/client")) {
          return json({ response: { sessions: [] } }, "__client=boot; Path=/");
        }
        if (url.endsWith("/sign_ins"))
          return json({ response: { id: "sia_1" } });
        // Clerk rejects the password.
        return new Response("", { status: 422 });
      },
    );

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(401);
    // Nothing usable was obtained, so nothing may be written over the store.
    expect(MODEL_CACHE.put).not.toHaveBeenCalled();
  });

  it("gives up quietly when the sign-in start is rejected", async () => {
    const MODEL_CACHE = kv();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/client")) {
          return json({ response: { sessions: [] } }, "__client=boot; Path=/");
        }
        return new Response("", { status: 400 });
      },
    );

    const res = await call(
      { ...base, MODEL_CACHE },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(401);
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    // No point attempting the password once the flow has no sign-in to attach to.
    expect(urls.some((u) => u.includes("attempt_first"))).toBe(false);
  });

  it("401s with a config error when neither a cookie nor credentials exist", async () => {
    vi.spyOn(globalThis, "fetch");
    const res = await call(
      { RELAY_API_KEY: "sk-relay-xyz" },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("CLERK_EMAIL");
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
