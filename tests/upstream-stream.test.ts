import { describe, expect, it } from "vitest";
import {
  formatCitations,
  inlineCitationLinks,
  parseTrailers,
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

  it("produces a Markdown sources block with a numbered list", () => {
    const out = formatCitations(URLS);
    expect(out).toBe(
      "\n\n---\n**Sources**\n\n" +
        "1. https://example.com/1\n" +
        "2. https://example.com/2\n" +
        "3. https://example.com/3",
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
