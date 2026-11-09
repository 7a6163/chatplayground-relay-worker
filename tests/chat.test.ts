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

/** An upstream reply: AI SDK UI-message stream events, then [DONE]. */
function reply(...events: object[]): Response {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
const text = (delta: string) => ({ type: "text-delta", id: "t", delta });
const ok = () => reply(text("ok"));

const env = {
  UPSTREAM_CHAT_URL: "https://up.example.test/api/chat",
  UPSTREAM_ORIGIN: "https://web.example.test",
  UPSTREAM_REFERER: "https://web.example.test/",
  CLERK_FAPI_URL: "https://clerk.example.test",
};

/** Mirrors the shape of /api/models. */
const FEED = [
  { slug: "gpt-6-luna", provider: "openai", group: "chat", premiumOnly: false },
  // At least one, or discover() logs that the field changed shape.
  {
    slug: "sonar-pro",
    provider: "perplexity",
    group: "chat",
    premiumOnly: true,
  },
  { slug: "gpt-image-2.5", provider: "openai", group: "image" },
];

/** Serve the catalogue; delegate /api/chat to the test's own reply. */
function upstream(respond: (url: string) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("/api/models") ? Response.json(FEED) : respond(url);
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
  model: "gpt-6-luna",
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
    const res = await post({ model: "gpt-6-luna", messages: [] });
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

  it("404s a provider prefix with no slug after it", async () => {
    upstream(() => new Response("unreachable"));
    const res = await post({ ...hello, model: "openai/" });
    expect(res.status).toBe(404);
  });

  it("accepts a provider/slug id for a known model", async () => {
    upstream(ok);
    const res = await post({ ...hello, model: "openai/gpt-6-luna" });
    expect(res.status).toBe(200);
    expect(JSON.parse(String(chatCall()[1].body)).modelSlug).toBe("gpt-6-luna");
  });

  it("passes an unknown provider/slug through as that slug", async () => {
    upstream(ok);
    const res = await post({ ...hello, model: "meta/llama-9" });
    expect(res.status).toBe(200);
    expect(JSON.parse(String(chatCall()[1].body)).modelSlug).toBe("llama-9");
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
  it("returns an OpenAI envelope with upstream's own token counts", async () => {
    upstream(() =>
      reply(
        { type: "start", messageId: "m" },
        { type: "reasoning-delta", id: "r", delta: "hmm" },
        text("Hi "),
        text("there!"),
        {
          type: "finish",
          messageMetadata: {
            usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2 },
          },
        },
      ),
    );

    const res = await post(hello);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletionResponse;

    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-6-luna");
    expect(body.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "Hi there!" },
        finish_reason: "stop",
      },
    ]);
    expect(body.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
  });

  it("falls back to a chars/4 estimate when upstream sends no usage", async () => {
    upstream(() => reply(text("Hi there!")));
    const body = (await (await post(hello)).json()) as ChatCompletionResponse;
    // "Hello" → 2, "Hi there!" → 3.
    expect(body.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
  });

  it("inlines [N] markers and appends Sources, estimating on the raw output", async () => {
    upstream(() =>
      reply(text("Paris [1] is nice."), {
        type: "source-url",
        sourceId: "s",
        url: "https://a.test",
      }),
    );

    const res = await post({ ...hello, model: "sonar-pro" });
    const body = (await res.json()) as ChatCompletionResponse;

    expect(body.choices[0]?.message.content).toBe(
      "Paris [\\[1\\]](https://a.test) is nice." +
        "\n\n---\n**Sources**\n\n1. [https://a.test](https://a.test)",
    );
    // 18 raw chars → 5. The relay-added links must not inflate this.
    expect(body.usage.completion_tokens).toBe(5);
  });

  it("502s with upstream's text when the reply fails mid-stream", async () => {
    upstream(() => reply(text("par"), { type: "error", errorText: "boom" }));
    const res = await post(hello);
    expect(res.status).toBe(502);
    expect((await envelope(res)).message).toBe(
      "Upstream failed mid-reply: boom",
    );
  });
});

describe("POST /v1/chat/completions — upstream request", () => {
  it("posts to the chat URL with the caller's JWT and the new body shape", async () => {
    upstream(ok);

    await post({ ...hello, user: "01a1bebe-a301" });
    const [url, init] = chatCall();

    expect(url).toBe("https://up.example.test/api/chat");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${JWT}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      modelSlug: "gpt-6-luna",
      submissionId: expect.any(String),
      message: { text: "Hello" },
      conversationId: "01a1bebe-a301",
      noSave: true,
    });
  });

  it("honors metadata.save by clearing noSave", async () => {
    upstream(ok);
    await post({ ...hello, metadata: { save: true } });
    expect(JSON.parse(String(chatCall()[1].body))).toMatchObject({
      noSave: false,
    });
  });

  it("folds history into one role-labelled prompt", async () => {
    upstream(ok);

    const res = await post({
      model: "gpt-6-luna",
      messages: [
        { role: "developer", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
        // An assistant turn that only carried tool_calls.
        { role: "assistant", content: null },
        { role: "tool", content: "42" },
      ],
    });
    expect(res.status).toBe(200);

    expect(JSON.parse(String(chatCall()[1].body)).message).toEqual({
      text: "System: Be brief.\n\nUser: line one\nline two\n\nAssistant:\n\nTool: 42",
    });
  });

  it("sends a lone message as bare text, null as empty", async () => {
    upstream(ok);
    await post({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: null }],
    });
    expect(JSON.parse(String(chatCall()[1].body)).message).toEqual({
      text: "",
    });
  });

  it("uploads each image and attaches its fileId, keeping text separate", async () => {
    const PNG = "data:image/png;base64," + btoa("\x89PNG fake");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/models")) return Response.json(FEED);
        if (url.endsWith("/api/uploads/presign")) {
          const { originalName } = JSON.parse(String(init?.body));
          return Response.json({
            fileId: `f-${originalName}`,
            uploadUrl: `https://r2.test/${originalName}`,
            headers: { "Content-Type": "image/png" },
          });
        }
        if (url.startsWith("https://r2.test/")) return new Response(null);
        const done = /\/api\/uploads\/(.+)\/complete$/.exec(url);
        if (done) return Response.json({ id: decodeURIComponent(done[1]!) });
        if (url === "https://i.test/cat.png") {
          return new Response("png", {
            headers: { "content-type": "image/png" },
          });
        }
        return ok();
      },
    );

    const res = await post({
      model: "gpt-6-luna",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare" },
            { type: "image_url", image_url: { url: PNG } },
            { type: "image_url", image_url: { url: "https://i.test/cat.png" } },
          ],
        },
        // A fileId from POST /v1/files is attached as-is.
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "01a1-file" } }],
        },
      ],
    });
    expect(res.status).toBe(200);

    const chatInit = vi
      .mocked(fetch)
      .mock.calls.find(
        ([u]) => String(u) === "https://up.example.test/api/chat",
      )?.[1];
    expect(JSON.parse(String(chatInit?.body)).message).toEqual({
      text: "User: Compare\n\nUser:",
      attachments: [
        { fileId: "f-image" },
        { fileId: "f-cat.png" },
        { fileId: "01a1-file" },
      ],
    });
  });

  it("rejects more than four images before calling upstream", async () => {
    upstream(ok);
    const img = { type: "image_url", image_url: { url: "01a1-file" } };
    const res = await post({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: [img, img, img, img, img] }],
    });
    expect(res.status).toBe(400);
    expect((await envelope(res)).message).toContain("At most 4 images");
    // Only the catalogue was fetched.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("rejects an image part with no url", async () => {
    upstream(ok);
    const res = await post({
      model: "gpt-6-luna",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: {} }] },
      ],
    });
    expect(res.status).toBe(400);
    expect((await envelope(res)).param).toBe("messages");
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

  it("re-emits upstream text deltas as chat.completion.chunk SSE", async () => {
    upstream(() => reply(text("Hi "), text("there!")));

    const res = await post({ ...hello, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );

    const events = await sse(res);
    expect(events.at(-1)).toBe("[DONE]");

    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(chunks[0].model).toBe("gpt-6-luna");
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });

    const deltas = chunks
      .map((c) => c.choices[0].delta.content)
      .filter((t) => t !== undefined);
    expect(deltas).toEqual(["Hi ", "there!"]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("appends the Sources block as a final delta", async () => {
    upstream(() =>
      reply(text("See [1]."), { type: "source-url", url: "https://a.test" }),
    );

    const res = await post({ ...hello, model: "sonar-pro", stream: true });
    const chunks = (await sse(res))
      .filter((e) => e !== "[DONE]")
      .map((e) => JSON.parse(e));
    const all = chunks.map((c) => c.choices[0].delta.content ?? "").join("");

    // The streaming path can only append — [1] stays a literal marker.
    expect(all).toBe(
      "See [1].\n\n---\n**Sources**\n\n1. [https://a.test](https://a.test)",
    );
  });
});
