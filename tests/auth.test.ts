import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { auth, safeEqual } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/error-handler";

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

// biome-ignore lint/suspicious/noExplicitAny: minimal test env stub
function call(env: any, headers: Record<string, string>) {
  const app = new Hono<any>();
  app.onError(errorHandler);
  app.use("*", auth);
  app.get("/", (c) => c.json({ clerkUserId: c.get("clerkUserId") }));
  return app.request("/", { headers }, env);
}

describe("auth — gateway mode (RELAY_API_KEY set)", () => {
  const env = { RELAY_API_KEY: "sk-relay-xyz", CLERK_USER_ID: "user_stored123" };

  it("accepts the correct key and uses the stored Clerk ID upstream", async () => {
    const res = await call(env, { authorization: "Bearer sk-relay-xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clerkUserId: "user_stored123" });
  });

  it("rejects a wrong key", async () => {
    const res = await call(env, { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects a missing key", async () => {
    const res = await call(env, {});
    expect(res.status).toBe(401);
  });

  it("ignores a caller-supplied X-Clerk-User-Id in gateway mode", async () => {
    const res = await call(env, {
      authorization: "Bearer sk-relay-xyz",
      "x-clerk-user-id": "user_attacker",
    });
    expect(await res.json()).toEqual({ clerkUserId: "user_stored123" });
  });

  it("401s when the stored CLERK_USER_ID is missing/malformed", async () => {
    const res = await call(
      { RELAY_API_KEY: "sk-relay-xyz", CLERK_USER_ID: "not-a-clerk-id" },
      { authorization: "Bearer sk-relay-xyz" },
    );
    expect(res.status).toBe(401);
  });
});

describe("auth — passthrough mode (no RELAY_API_KEY)", () => {
  it("accepts a well-formed Clerk ID as Bearer", async () => {
    const res = await call({}, { authorization: "Bearer user_caller99" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clerkUserId: "user_caller99" });
  });

  it("accepts X-Clerk-User-Id header", async () => {
    const res = await call({}, { "x-clerk-user-id": "user_caller99" });
    expect(await res.json()).toEqual({ clerkUserId: "user_caller99" });
  });

  it("rejects a malformed id", async () => {
    const res = await call({}, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("empty RELAY_API_KEY falls back to passthrough (not an open gateway)", async () => {
    const res = await call(
      { RELAY_API_KEY: "" },
      { authorization: "Bearer user_caller99" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clerkUserId: "user_caller99" });
  });
});
