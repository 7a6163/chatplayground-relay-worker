import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
} from "../types/openai";

// chatplayground appends `CHAT_ID:<cuid>` at the very end of the stream as a
// sentinel. CUID format: `c` + ≥20 chars of [a-z0-9]. We strip it before
// emitting content.
const SENTINEL_RE = /CHAT_ID:(c[a-z0-9]{20,})$/;
const HOLDBACK_CHARS = 100;

// perplexity emits its citation list as a trailing chunk of the form
// `CITATIONS:["url1","url2",...]`. The web client parses it as structured
// citations; we strip it from the prose and re-format as Markdown so
// OpenAI-compatible clients render proper links.
const CITATIONS_RE = /CITATIONS:(\[[\s\S]*?\])/;
const CITATIONS_MARKER = "CITATIONS:[";
const CHAT_ID_MARKER_RE = /CHAT_ID:c[a-z0-9]{20,}/;

export interface ParsedUpstream {
  content: string;
  chatId: string | null;
  citations: readonly string[];
}

/** Read entire upstream body, strip trailers, return content + chatId + citations. */
export async function collectUpstream(
  body: ReadableStream<Uint8Array>,
): Promise<ParsedUpstream> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) buf += decoder.decode(value, { stream: true });
  }
  buf += decoder.decode();
  return parseTrailers(buf);
}

/**
 * Strip trailing CHAT_ID sentinel and perplexity CITATIONS payload from a
 * fully-buffered upstream response. Order-tolerant: CITATIONS is matched
 * with no anchor first, so either ordering (CITATIONS-then-CHAT_ID or
 * CHAT_ID-then-CITATIONS) is handled.
 */
export function parseTrailers(buf: string): ParsedUpstream {
  let working = buf;
  let citations: readonly string[] = [];

  const cm = CITATIONS_RE.exec(working);
  if (cm?.[1]) {
    const parsed = safeParseStringArray(cm[1]);
    if (parsed) {
      citations = parsed;
      working = working.slice(0, cm.index) + working.slice(cm.index + cm[0].length);
    }
  }

  const sm = SENTINEL_RE.exec(working);
  let chatId: string | null = null;
  if (sm) {
    chatId = sm[1] ?? null;
    working = working.slice(0, sm.index);
  }

  return { content: working, chatId, citations };
}

function safeParseStringArray(json: string): readonly string[] | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    return value.filter((u): u is string => typeof u === "string");
  } catch {
    return null;
  }
}

/** Markdown sources block appended at the end of an assistant message. */
export function formatCitations(citations: readonly string[]): string {
  if (citations.length === 0) return "";
  const lines = citations.map((url, i) => `${i + 1}. ${url}`);
  return `\n\n---\n**Sources**\n\n${lines.join("\n")}`;
}

const INLINE_CITATION_RE = /\[(\d+)\]/g;

/**
 * Rewrite `[N]` citation markers in `text` to Markdown links pointing at the
 * Nth citation URL. Used only on the non-streaming path — the streaming path
 * flushes prose live and can only append a sources block at the end.
 */
export function inlineCitationLinks(
  text: string,
  citations: readonly string[],
): string {
  if (citations.length === 0) return text;
  return text.replace(INLINE_CITATION_RE, (match, idxStr: string) => {
    const idx = Number(idxStr);
    const url = citations[idx - 1];
    if (!url) return match; // unknown index — leave the literal marker
    return `[\\[${idx}\\]](${url})`;
  });
}

interface ChunkMeta {
  id: string;
  model: string;
  created: number;
}

/**
 * Wrap upstream text stream as OpenAI-format chat.completion.chunk SSE.
 *
 * Flush boundary: until either trailer marker (CITATIONS or CHAT_ID) appears
 * in the buffer, we hold back HOLDBACK_CHARS to guard against a partial
 * sentinel landing on a chunk boundary. Once a marker shows up, we lock the
 * flush boundary at the earliest marker and stop flushing past it, so the
 * trailer never reaches the client mid-stream.
 *
 * At stream end we parse the held-back tail, emit any remaining prose, and —
 * if perplexity citations were collected — append a Markdown sources block
 * as one final delta before the `[DONE]` terminator.
 */
export function streamUpstreamAsOpenAI(
  body: ReadableStream<Uint8Array>,
  meta: ChunkMeta,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function sse(
    delta: ChatCompletionChunkDelta,
    finishReason: "stop" | null = null,
  ): Uint8Array {
    const chunk: ChatCompletionChunk = {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      let pending = "";

      controller.enqueue(sse({ role: "assistant" }));

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          pending += decoder.decode(value, { stream: true });

          const boundary = flushBoundary(pending);
          if (boundary > 0) {
            const out = pending.slice(0, boundary);
            pending = pending.slice(boundary);
            controller.enqueue(sse({ content: out }));
          }
        }

        pending += decoder.decode();
        const { content, citations } = parseTrailers(pending);
        if (content) controller.enqueue(sse({ content }));
        const sources = formatCitations(citations);
        if (sources) controller.enqueue(sse({ content: sources }));

        controller.enqueue(sse({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function flushBoundary(pending: string): number {
  const citIdx = pending.indexOf(CITATIONS_MARKER);
  const cidMatch = CHAT_ID_MARKER_RE.exec(pending);
  const cidIdx = cidMatch ? cidMatch.index : -1;

  if (citIdx >= 0 && cidIdx >= 0) return Math.min(citIdx, cidIdx);
  if (citIdx >= 0) return citIdx;
  if (cidIdx >= 0) return cidIdx;
  return Math.max(0, pending.length - HOLDBACK_CHARS);
}
