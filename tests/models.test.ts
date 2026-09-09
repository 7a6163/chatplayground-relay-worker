import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/error-handler";
import models from "../src/routes/models";
import type { ModelList } from "../src/types/openai";
import { resetModelCache } from "../src/utils/model-discovery";

const env = { UPSTREAM_CHAT_URL: "https://up.example.test/api/chat/azure" };

const FEED = [
  {
    botId: "gpt-5.6-luna",
    modelName: "gpt-5.6-luna",
    provider: "OpenAI",
    group: "chat",
    endpoint: "azure",
    premiumOnly: false,
  },
  {
    botId: "grok-4.6",
    modelName: "grok-4.6",
    provider: "xAI",
    group: "chat",
    endpoint: "lmsys",
    premiumOnly: true,
  },
  // Not a chat model — discovery drops it before the listing ever sees it.
  { botId: "dall-e", modelName: "dall-e", provider: "OpenAI", group: "image" },
];

// oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
function get(testEnv: any = env) {
  // oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
  const app = new Hono<any>();
  app.onError(errorHandler);
  app.route("/", models);
  return app.request("/v1/models", {}, testEnv);
}

beforeEach(() => {
  resetModelCache();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(FEED));
});
afterEach(() => vi.restoreAllMocks());

describe("GET /v1/models", () => {
  it("lists non-premium chat models in the OpenAI shape", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelList;

    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      {
        id: "gpt-5.6-luna",
        object: "model",
        created: expect.any(Number),
        owned_by: "openai",
      },
    ]);
  });

  it("hides premiumOnly models unless PREMIUM_MODELS is set", async () => {
    const res = await get({ ...env, PREMIUM_MODELS: "true" });
    const ids = ((await res.json()) as ModelList).data.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-luna", "grok-4.6"]);
  });

  it("503s when discovery fails instead of serving an empty list", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await get();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_discovery_failed");
  });
});
