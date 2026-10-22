import { describe, expect, it, vi } from "vitest";
import {
  collectUpstream,
  formatCitations,
  inlineCitationLinks,
  parseTrailers,
  streamUpstreamAsOpenAI,
} from "../src/utils/upstream-stream";

const CUID = "cabcdefghijklmnopqrstuvwx"; // 24 chars after the leading "c"
const URLS = [
  "https://example.com/1",
  "https://example.com/2",
  "https://example.com/3",
];

describe("parseTrailers", () => {
  it("returns the buffer unchanged when no trailer is present", () => {
    const out = parseTrailers("hello world");
    expect(out).toEqual({
      content: "hello world",
      chatId: null,
      citations: [],
    });
  });

  it("strips the CHAT_ID sentinel and extracts the cuid", () => {
    const out = parseTrailers(`prose\nCHAT_ID:${CUID}`);
    expect(out.content).toBe("prose\n");
    expect(out.chatId).toBe(CUID);
    expect(out.citations).toEqual([]);
  });

  it("strips a leading CHAT_ID sentinel (newer upstream order)", () => {
    const out = parseTrailers(`  CHAT_ID:${CUID}\nHi back!`);
    expect(out.content).toBe("Hi back!");
    expect(out.chatId).toBe(CUID);
  });

  it("strips the perplexity CITATIONS payload and parses URLs", () => {
    const json = JSON.stringify(URLS);
    const out = parseTrailers(`answer text CITATIONS:${json}`);
    expect(out.content).toBe("answer text ");
    expect(out.citations).toEqual(URLS);
    expect(out.chatId).toBeNull();
  });

  it("handles CITATIONS followed by CHAT_ID (order-tolerant)", () => {
    const json = JSON.stringify(URLS);
    const out = parseTrailers(`answer CITATIONS:${json}CHAT_ID:${CUID}`);
    expect(out.content).toBe("answer ");
    expect(out.citations).toEqual(URLS);
    expect(out.chatId).toBe(CUID);
  });

  it("handles CHAT_ID followed by CITATIONS (order-tolerant)", () => {
    const json = JSON.stringify(URLS);
    const out = parseTrailers(`answer CHAT_ID:${CUID}CITATIONS:${json}`);
    expect(out.content).toBe("answer ");
    expect(out.citations).toEqual(URLS);
    expect(out.chatId).toBe(CUID);
  });

  it("leaves a malformed CITATIONS payload untouched", () => {
    const malformed = "answer CITATIONS:[this is not, valid json]";
    const out = parseTrailers(malformed);
    expect(out.citations).toEqual([]);
    // Malformed payload is left in content rather than silently corrupted.
    expect(out.content).toBe(malformed);
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

function upstreamOf(pieces: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

/** Content deltas, in order, from the SSE the relay emits. */
async function deltas(pieces: string[]): Promise<string[]> {
  const sse = await new Response(
    streamUpstreamAsOpenAI(upstreamOf(pieces), META),
  ).text();
  return sse
    .split("\n\n")
    .filter((b) => b.startsWith("data: {"))
    .map((b) => JSON.parse(b.slice(6)).choices[0].delta.content)
    .filter((t): t is string => t !== undefined);
}

describe("streamUpstreamAsOpenAI — markers away from the end", () => {
  const prose = "word ".repeat(100); // 500 chars, well past the holdback

  it("keeps flowing past a CHAT_ID mid-prose, matching the buffered path", async () => {
    const pieces = [`See CHAT_ID:${CUID} here. `, prose, prose, prose];

    const out = await deltas(pieces);
    const buffered = await collectUpstream(upstreamOf(pieces));

    expect(out.join("")).toBe(buffered.content);
    expect(out.join("")).toBe(`See  here. ${prose}${prose}${prose}`);
    // Flushed chunk by chunk, not held until EOF.
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("cuts a leading CITATIONS block out and still appends Sources", async () => {
    const json = JSON.stringify(URLS);
    const out = await deltas([
      `CITATIONS:${json}`,
      prose,
      prose,
      `CHAT_ID:${CUID}`,
    ]);

    expect(out.join("")).toBe(`${prose}${prose}${formatCitations(URLS)}`);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("holds an unclosed CITATIONS array that outgrows the holdback", async () => {
    const half = JSON.stringify(URLS).slice(0, -1); // no closing ]
    const out = await deltas([
      "Answer. ",
      `CITATIONS:${half}`,
      `,"${"https://example.com/".padEnd(200, "x")}"]`,
      `CHAT_ID:${CUID}`,
    ]);

    // The raw array never reaches the client, even in part.
    expect(out.some((d) => d.includes("CITATIONS"))).toBe(false);
    expect(out.join("")).toContain("**Sources**");
  });
});

describe("streamUpstreamAsOpenAI — prose that says CITATIONS:[", () => {
  it("releases an array that never closes instead of holding to EOF", async () => {
    const prose = "word ".repeat(1000); // 5,000 chars per chunk
    const pieces = ["Use CITATIONS:[ like this. ", ...Array(8).fill(prose)];

    const out = await deltas(pieces);

    expect(out.join("")).toBe(`Use CITATIONS:[ like this. ${prose.repeat(8)}`);
    // Released once past the cap, then flowing — not one delta at EOF.
    expect(out.length).toBeGreaterThan(2);
  });
});

describe("streamUpstreamAsOpenAI — cancellation", () => {
  it("cancels the upstream read when the client goes away", async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(500)));
      },
      cancel,
    });

    const reader = streamUpstreamAsOpenAI(upstream, META).getReader();
    await reader.read(); // the role delta
    await reader.cancel("client disconnected");

    expect(cancel).toHaveBeenCalledWith("client disconnected");
  });
});
