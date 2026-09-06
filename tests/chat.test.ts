import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/error-handler";
import chat from "../src/routes/chat";
import type { ChatCompletionResponse } from "../src/types/openai";
import { resetModelCache } from "../src/utils/model-discovery";

// Everything real except the network: auth, the error envelope, discovery, the
// request builder and the stream transform all run. `fetch` is the only seam,
// which is also the only boundary a Workers-runtime pool would restore — see
// vitest.config.ts.

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2ln-bmF0dXJl";
const CHAT_ID = "CHAT_ID:clm1234567890abcdefgh";

const env = {
  UPSTREAM_CHAT_URL: "https://up.example.test/api/chat/azure",
  UPSTREAM_ORIGIN: "https://web.example.test",
  UPSTREAM_REFERER: "https://web.example.test/",
  UPSTREAM_UPLOAD_URL: "https://up.example.test/api/upload",
  CLERK_FAPI_URL: "https://clerk.example.test",
};

/** Two models, one per endpoint, mirroring the shape of /api/models. */
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
    botId: "perplexity-sonar",
    modelName: "sonar",
    provider: "Perplexity",
    group: "chat",
    endpoint: "perplexity",
    // At least one, or discover() logs that the field changed shape.
    premiumOnly: true,
  },
  { botId: "dall-e", modelName: "dall-e", provider: "OpenAI", group: "image" },
];

/** Serve the catalogue; delegate /api/chat/* to the test's own reply. */
function upstream(reply: (url: string) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("/api/models") ? Response.json(FEED) : reply(url);
    },
  );
}

/** The chat route as index.ts mounts it: error envelope + auth in front. */
// oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
function post(body: unknown, testEnv: any = env) {
  // oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
  const app = new Hono<any>();
  app.onError(errorHandler);
  app.use("/v1/*", auth);
  app.route("/", chat);
  return app.request(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${JWT}`,
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    testEnv,
  );
}

const hello = {
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "Hello" }],
};

async function envelope(res: Response) {
  const body = (await res.json()) as {
    error: { message: string; code: string | null; param: string | null };
  };
  return body.error;
}

/** The chat call is always the fetch after the catalogue fetch. */
function chatCall(): [string, RequestInit] {
  return vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
}

beforeEach(() => resetModelCache());
afterEach(() => vi.restoreAllMocks());

describe("POST /v1/chat/completions — request validation", () => {
  it("rejects a body that isn't JSON without calling upstream", async () => {
    upstream(() => new Response("unreachable"));
    const res = await post("not json at all");
    expect(res.status).toBe(400);
    expect((await envelope(res)).message).toBe("Request body must be JSON.");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a missing model, naming the param", async () => {
    upstream(() => new Response("unreachable"));
    const res = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect((await envelope(res)).param).toBe("model");
  });

  it("rejects empty messages, naming the param", async () => {
    upstream(() => new Response("unreachable"));
    const res = await post({ model: "gpt-5.6-luna", messages: [] });
    expect(res.status).toBe(400);
    expect((await envelope(res)).param).toBe("messages");
  });
});

describe("POST /v1/chat/completions — model resolution", () => {
  it("404s a bare id the registry doesn't know", async () => {
    upstream(() => new Response("unreachable"));
    const res = await post({ ...hello, model: "no-such-model" });
    expect(res.status).toBe(404);
    expect((await envelope(res)).code).toBe("model_not_found");
  });

  it("passes an unknown provider/model through to the lmsys catch-all", async () => {
    upstream(() => new Response(`ok${CHAT_ID}`));
    const res = await post({ ...hello, model: "meta/llama-9" });
    expect(res.status).toBe(200);
    expect(chatCall()[0]).toBe("https://up.example.test/api/chat/lmsys");
  });

  it("503s when discovery is down rather than claiming the model is gone", async () => {
    upstream(() => new Response("unreachable"));
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post(hello);
    expect(res.status).toBe(503);
    expect((await envelope(res)).code).toBe("model_discovery_failed");
  });
});

describe("POST /v1/chat/completions — upstream failures", () => {
  it("keeps a 403 on its own status and forwards upstream's own wording", async () => {
    upstream(
      () =>
        new Response("This model is only available to active subscribers", {
          status: 403,
        }),
    );
    const res = await post(hello);
    expect(res.status).toBe(403);
    expect((await envelope(res)).message).toContain(
      "This model is only available to active subscribers",
    );
  });

  it("folds a 500 into 502", async () => {
    upstream(() => new Response("boom", { status: 500 }));
    const res = await post(hello);
    expect(res.status).toBe(502);
  });

  it("says so explicitly when upstream sends no message", async () => {
    upstream(() => new Response("", { status: 502 }));
    const res = await post(hello);
    expect((await envelope(res)).message).toContain("with no message");
  });

  it("treats a 2xx with no body as a failure, not an empty completion", async () => {
    upstream(() => new Response(null, { status: 204 }));
    const res = await post(hello);
    expect(res.status).toBe(502);
    expect((await envelope(res)).code).toBe("upstream_502");
  });
});

describe("POST /v1/chat/completions — non-streaming", () => {
  it("returns an OpenAI envelope with the trailer stripped", async () => {
    upstream(() => new Response(`Hi there!${CHAT_ID}`));

    const res = await post(hello);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletionResponse;

    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "Hi there!" },
        finish_reason: "stop",
      },
    ]);
    // ~4 chars per token: "Hello" → 2, "Hi there!" → 3.
    expect(body.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
  });

  it("inlines [N] markers and appends Sources, billing only the raw output", async () => {
    upstream(
      () =>
        new Response(
          `Paris [1] is nice.CITATIONS:["https://a.test"]${CHAT_ID}`,
        ),
    );

    const res = await post({ ...hello, model: "perplexity-sonar" });
    const body = (await res.json()) as ChatCompletionResponse;

    expect(body.choices[0]?.message.content).toBe(
      "Paris [\\[1\\]](https://a.test) is nice." +
        "\n\n---\n**Sources**\n\n1. [https://a.test](https://a.test)",
    );
    // 18 raw chars → 5. The relay-added links must not inflate this.
    expect(body.usage.completion_tokens).toBe(5);
  });

  it("counts text parts only when a message is multimodal", async () => {
    upstream(() => new Response(`ok${CHAT_ID}`));

    const res = await post({
      model: "gpt-5.6-luna",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "abcd" },
            {
              type: "image_url",
              image_url: { url: `data:${"x".repeat(500)}` },
            },
          ],
        },
      ],
    });
    const body = (await res.json()) as ChatCompletionResponse;
    expect(body.usage.prompt_tokens).toBe(1);
  });
});

describe("POST /v1/chat/completions — upstream request", () => {
  it("routes per model and forwards the caller's session JWT", async () => {
    upstream(() => new Response(`ok${CHAT_ID}`));

    await post({ ...hello, model: "perplexity-sonar", user: "cabc123" });
    const [url, init] = chatCall();

    expect(url).toBe("https://up.example.test/api/chat/perplexity");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${JWT}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      modelName: "sonar",
      botId: "perplexity-sonar",
      chatId: "cabc123",
      noSave: true,
    });
  });

  it("honors metadata.save by clearing noSave", async () => {
    upstream(() => new Response(`ok${CHAT_ID}`));
    await post({ ...hello, metadata: { save: true } });
    expect(JSON.parse(String(chatCall()[1].body))).toMatchObject({
      noSave: false,
    });
  });
});

describe("POST /v1/chat/completions — streaming", () => {
  /** Every `data:` payload of an SSE response, `[DONE]` included. */
  async function sse(res: Response): Promise<string[]> {
    return (await res.text())
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length));
  }

  it("wraps the upstream text as chat.completion.chunk SSE", async () => {
    upstream(() => new Response(`Hi there!${CHAT_ID}`));

    const res = await post({ ...hello, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );

    const events = await sse(res);
    expect(events.at(-1)).toBe("[DONE]");

    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(chunks[0].model).toBe("gpt-5.6-luna");
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });

    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("Hi there!");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("appends the Sources block as a final delta", async () => {
    upstream(
      () => new Response(`See [1].CITATIONS:["https://a.test"]${CHAT_ID}`),
    );

    const res = await post({
      ...hello,
      model: "perplexity-sonar",
      stream: true,
    });
    const chunks = (await sse(res))
      .filter((e) => e !== "[DONE]")
      .map((e) => JSON.parse(e));
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");

    // The streaming path can only append — [1] stays a literal marker.
    expect(text).toBe(
      "See [1].\n\n---\n**Sources**\n\n1. [https://a.test](https://a.test)",
    );
  });
});
