import { describe, expect, it, vi } from "vitest";
import {
  collectUpstream,
  formatCitations,
  inlineCitationLinks,
  streamUpstreamAsOpenAI,
} from "../src/utils/upstream-stream";

const URLS = [
  "https://example.com/1",
  "https://example.com/2",
  "https://example.com/3",
];

const sse = (...evs: object[]) =>
  evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
  "data: [DONE]\n\n";
const text = (delta: string) => ({ type: "text-delta", id: "t", delta });
const finish = {
  type: "finish",
  finishReason: "stop",
  messageMetadata: {
    status: "complete",
    usage: { inputTokens: 36, outputTokens: 4, reasoningTokens: 8 },
  },
};

function upstreamOf(pieces: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

describe("collectUpstream", () => {
  it("joins text deltas and ignores reasoning and lifecycle events", async () => {
    const out = await collectUpstream(
      upstreamOf([
        sse(
          { type: "start", messageId: "m" },
          { type: "reasoning-delta", id: "r", delta: "thinking" },
          text("p"),
          text("ong"),
          finish,
        ),
      ]),
    );
    expect(out.content).toBe("pong");
    expect(out.citations).toEqual([]);
  });

  it("counts reasoning inside output tokens, as OpenAI does", async () => {
    const out = await collectUpstream(upstreamOf([sse(text("x"), finish)]));
    expect(out.usage).toEqual({ inputTokens: 36, outputTokens: 12 });
  });

  it("treats a missing or non-numeric count as 0", async () => {
    const out = await collectUpstream(
      upstreamOf([
        sse(text("x"), {
          type: "finish",
          messageMetadata: { usage: { inputTokens: 5, outputTokens: "4" } },
        }),
      ]),
    );
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 0 });
  });

  it("reports null usage when finish carries no counts", async () => {
    const out = await collectUpstream(
      upstreamOf([sse(text("x"), { type: "finish" })]),
    );
    expect(out.usage).toBeNull();
  });

  it("collects source-url events as citations", async () => {
    const out = await collectUpstream(
      upstreamOf([
        sse(
          text("a [1]"),
          { type: "source-url", sourceId: "s1", url: URLS[0] },
          { type: "source-url", sourceId: "s2", url: 42 },
        ),
      ]),
    );
    expect(out.citations).toEqual([URLS[0]]);
  });

  it("parses events split mid-line across chunks, and skips junk lines", async () => {
    const junk = [
      ": comment",
      "data: not json",
      "data: 42",
      'data: {"no":"type"}',
      'data: {"type":"text-delta"}', // no delta
    ].join("\n");
    const raw = `${junk}\n\n${sse(text("hello"), text(" world"))}`;
    const out = await collectUpstream(
      upstreamOf([raw.slice(0, 40), raw.slice(40, 90), raw.slice(90)]),
    );
    expect(out.content).toBe("hello world");
  });

  it("throws a 502 carrying upstream's text on an error event", async () => {
    await expect(
      collectUpstream(
        upstreamOf([sse(text("par"), { type: "error", errorText: "boom" })]),
      ),
    ).rejects.toMatchObject({
      status: 502,
      message: "Upstream failed mid-reply: boom",
    });
  });

  it("says so when an error event carries no text", async () => {
    await expect(
      collectUpstream(upstreamOf([sse({ type: "error" })])),
    ).rejects.toMatchObject({
      message: "Upstream failed mid-reply: no message",
    });
  });
});

describe("formatCitations", () => {
  it("returns an empty string for no citations", () => {
    expect(formatCitations([])).toBe("");
  });

  it("produces a Markdown sources block with clickable links", () => {
    const out = formatCitations(URLS);
    expect(out).toBe(
      "\n\n---\n**Sources**\n\n" +
        "1. [https://example.com/1](https://example.com/1)\n" +
        "2. [https://example.com/2](https://example.com/2)\n" +
        "3. [https://example.com/3](https://example.com/3)",
    );
  });
});

describe("inlineCitationLinks", () => {
  it("returns text unchanged when there are no citations", () => {
    expect(inlineCitationLinks("answer [1] more", [])).toBe("answer [1] more");
  });

  it("rewrites known [N] markers as Markdown links with escaped brackets", () => {
    const out = inlineCitationLinks("see [1] and [2].", URLS);
    expect(out).toBe(
      "see [\\[1\\]](https://example.com/1) and [\\[2\\]](https://example.com/2).",
    );
  });

  it("rewrites adjacent markers like [7][2] independently", () => {
    const out = inlineCitationLinks("evidence [3][1]", URLS);
    expect(out).toBe(
      "evidence [\\[3\\]](https://example.com/3)[\\[1\\]](https://example.com/1)",
    );
  });

  it("leaves out-of-range markers as literal text", () => {
    const out = inlineCitationLinks("a [9] z", URLS);
    expect(out).toBe("a [9] z");
  });
});

const META = { id: "chatcmpl-x", model: "m", created: 0 };

/** Every `data:` payload the relay emits, `[DONE]` excluded. */
async function events(pieces: string[]) {
  const out = await new Response(
    streamUpstreamAsOpenAI(upstreamOf(pieces), META),
  ).text();
  return out
    .split("\n\n")
    .filter((b) => b.startsWith("data: {"))
    .map((b) => JSON.parse(b.slice(6)));
}

const contentOf = (evs: { choices?: { delta: { content?: string } }[] }[]) =>
  evs
    .map((e) => e.choices?.[0]?.delta.content)
    .filter((t): t is string => t !== undefined);

describe("streamUpstreamAsOpenAI", () => {
  it("emits one content delta per upstream text delta, then stop", async () => {
    const evs = await events([sse(text("p"), text("ong"), finish)]);
    expect(evs[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(contentOf(evs)).toEqual(["p", "ong"]);
    expect(evs.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("appends a Sources block for source-url events", async () => {
    const evs = await events([
      sse(text("See [1]."), { type: "source-url", url: URLS[0] }),
    ]);
    expect(contentOf(evs).join("")).toBe(
      `See [1].${formatCitations([URLS[0]!])}`,
    );
  });

  it("never splits a surrogate pair across deltas", async () => {
    // The lone high half arrives as its own delta, then a delta with no text.
    const evs = await events([
      sse(text("a"), text("\ud83d"), { type: "text-delta" }, text("\ude00b")),
    ]);
    expect(contentOf(evs)).toEqual(["a", "😀b"]);
  });

  it("turns an error event into an OpenAI error event and ends the stream", async () => {
    const out = await new Response(
      streamUpstreamAsOpenAI(
        upstreamOf([sse(text("par"), { type: "error", errorText: "boom" })]),
        META,
      ),
    ).text();
    expect(out).toContain(
      '"error":{"message":"Upstream failed mid-reply: boom","type":"upstream_error","code":"upstream_502","param":null}',
    );
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(out).not.toContain('"finish_reason":"stop"');
  });

  it("cancels the upstream read when the client goes away", async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse(text("x"))));
      },
      cancel,
    });

    const reader = streamUpstreamAsOpenAI(upstream, META).getReader();
    await reader.read(); // the role delta
    await reader.cancel("client disconnected");

    expect(cancel).toHaveBeenCalledWith("client disconnected");
  });
});
