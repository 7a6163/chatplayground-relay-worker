import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModels, resetModelCache } from "../src/utils/model-discovery";

const env = { UPSTREAM_CHAT_URL: "https://up.example.test/api/chat/azure" };

const entry = (over: Record<string, unknown> = {}) => ({
  botId: "gpt-5.6-luna",
  modelName: "gpt-5.6-luna",
  provider: "OpenAI",
  group: "chat",
  endpoint: "azure",
  premiumOnly: true,
  ...over,
});

function kv(stored: string | null = null) {
  const stub = {
    get: vi.fn().mockResolvedValue(stored ? JSON.parse(stored) : null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  // getModels only ever calls get/put; the rest of KVNamespace is dead weight.
  return stub as typeof stub & KVNamespace;
}

beforeEach(() => resetModelCache());
afterEach(() => vi.restoreAllMocks());

describe("getModels — the three layers", () => {
  it("fetches /api/models as a sibling of the chat URL, without credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([entry()]));

    await getModels(env);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://up.example.test/api/models");
    // The catalogue is impersonal — sending a credential buys nothing.
    expect(init.headers).toEqual({ accept: "application/json" });
  });

  it("serves the second call from memory without refetching", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([entry()]));
    await getModels(env);
    await getModels(env);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("prefers KV over a live fetch and warms memory from it", async () => {
    const MODEL_CACHE = kv(
      JSON.stringify([{ id: "cached", modelName: "cached" }]),
    );
    vi.spyOn(globalThis, "fetch");

    const first = await getModels({ ...env, MODEL_CACHE });
    expect(first[0]?.id).toBe("cached");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    await getModels({ ...env, MODEL_CACHE });
    expect(MODEL_CACHE.get).toHaveBeenCalledTimes(1);
  });

  it("writes a freshly discovered registry back to KV with a TTL", async () => {
    const MODEL_CACHE = kv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([entry()]));

    await getModels({ ...env, MODEL_CACHE });
    const [key, value, opts] = MODEL_CACHE.put.mock.calls[0] as [
      string,
      string,
      { expirationTtl: number },
    ];
    expect(key).toBe("models:v4");
    expect(JSON.parse(value)[0].id).toBe("gpt-5.6-luna");
    expect(opts.expirationTtl).toBe(3600);
  });
});

describe("getModels — parsing the feed", () => {
  const discover = async (feed: unknown) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(feed));
    return getModels(env);
  };

  it("keeps only chat models and lowercases the provider", async () => {
    const out = await discover([
      entry(),
      entry({ botId: "dall-e", group: "image" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe("openai");
    expect(out[0]?.upstreamModel).toBe("openai/gpt-5.6-luna");
  });

  it("does not double-prefix a modelName that already carries a slug", async () => {
    const out = await discover([
      entry({ modelName: "meta-llama/llama-4-scout", provider: "LMSYS" }),
    ]);
    expect(out[0]?.upstreamModel).toBe("meta-llama/llama-4-scout");
  });

  it("falls back to lmsys for an endpoint it doesn't know", async () => {
    const out = await discover([entry({ endpoint: "something-new" })]);
    expect(out[0]?.endpoint).toBe("lmsys");
  });

  it("keeps inactive models — the flag is UI-only", async () => {
    const out = await discover([entry({ active: false })]);
    expect(out).toHaveLength(1);
  });

  it("skips malformed entries rather than failing the whole feed", async () => {
    const out = await discover([null, { botId: "" }, "nope", entry()]);
    expect(out).toHaveLength(1);
  });

  it("warns when no entry is premiumOnly — the field may have changed shape", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await discover([entry({ premiumOnly: false })]);
    expect(err.mock.calls[0]?.[0]).toContain("No premiumOnly:true entries");
  });
});

describe("getModels — failure is a 503, never a stale list", () => {
  const failsWith = (fetchImpl: () => Promise<Response>) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    return expect(getModels(env)).rejects;
  };

  it("503s when the feed request fails", async () => {
    await failsWith(
      async () => new Response("", { status: 500 }),
    ).toMatchObject({ status: 503, code: "model_discovery_failed" });
  });

  it("503s when the feed is not an array", async () => {
    await failsWith(async () => Response.json({ models: [] })).toMatchObject({
      status: 503,
    });
  });

  it("503s when the feed holds no chat models at all", async () => {
    await failsWith(async () =>
      Response.json([entry({ group: "image" })]),
    ).toMatchObject({ status: 503 });
  });
});
