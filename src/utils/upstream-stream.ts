import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
} from "../types/openai";

// chatplayground marks the stream with a `CHAT_ID:<cuid>` sentinel. CUID
// format: `c` + ≥20 chars of [a-z0-9]. It has moved from the very end to the
// very start once already, so a complete one is stripped wherever it lands.
const SENTINEL_RE = /CHAT_ID:(c[a-z0-9]{20,})(?![a-z0-9])/;
// Mid-stream the cuid may still be arriving: complete only once a non-cuid
// character follows it.
const STREAM_SENTINEL_RE = /CHAT_ID:c[a-z0-9]{20,}(?=[^a-z0-9])/;
const HOLDBACK_CHARS = 100;
// A real citation list is a handful of URLs, far below this.
const MAX_CITATIONS_CHARS = 16_384;

// perplexity emits its citation list as a trailing chunk of the form
// `CITATIONS:["url1","url2",...]`. The web client parses it as structured
// citations; we strip it from the prose and re-format as Markdown so
// OpenAI-compatible clients render proper links.
const CITATIONS_RE = /CITATIONS:(\[[\s\S]*?\])/;
const CITATIONS_MARKER = "CITATIONS:[";
// Newer responses lead with the sentinel instead (`CHAT_ID:<cuid>\n<prose>`).
const LEADING_SENTINEL_RE = /^\s*CHAT_ID:(c[a-z0-9]{20,})(?![a-z0-9])\s*/;
// A buffer that may still grow into a leading sentinel: a prefix of the marker,
// or the marker with a cuid that may not have finished arriving.
const PARTIAL_LEADING_RE =
  /^\s*(?:C(?:H(?:A(?:T(?:_(?:I(?:D(?::(?:c[a-z0-9]*)?)?)?)?)?)?)?)?)?$/;

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
 * Strip the CHAT_ID sentinel and perplexity CITATIONS payload from a
 * fully-buffered upstream response. A leading sentinel also takes the
 * whitespace around it. Both are matched with no anchor, so either order
 * (CITATIONS-then-CHAT_ID or CHAT_ID-then-CITATIONS) is handled.
 */
export function parseTrailers(buf: string): ParsedUpstream {
  const lm = LEADING_SENTINEL_RE.exec(buf);
  if (!lm) return parseTail(buf);
  const rest = parseTail(buf.slice(lm[0].length));
  return { ...rest, chatId: rest.chatId ?? lm[1] ?? null };
}

/** parseTrailers without the leading-sentinel rule. */
function parseTail(buf: string): ParsedUpstream {
  let working = buf;
  let chatId: string | null = null;
  let citations: readonly string[] = [];

  const cm = CITATIONS_RE.exec(working);
  if (cm?.[1]) {
    const parsed = safeParseStringArray(cm[1]);
    if (parsed) {
      citations = parsed;
      working =
        working.slice(0, cm.index) + working.slice(cm.index + cm[0].length);
    }
  }

  const sm = SENTINEL_RE.exec(working);
  if (sm) {
    chatId = sm[1] ?? null;
    working =
      working.slice(0, sm.index) + working.slice(sm.index + sm[0].length);
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
  // Wrap each URL as a Markdown link so renderers that don't autolink bare
  // URLs still produce a clickable Sources list. Visible text stays the URL.
  const lines = citations.map((url, i) => `${i + 1}. [${url}](${url})`);
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
 * Flush boundary: a complete marker (CHAT_ID or a parseable CITATIONS array)
 * is cut out of the buffer as soon as it is whole, wherever it sits, so prose
 * keeps flowing past it. Otherwise we hold back HOLDBACK_CHARS against a
 * marker split across chunks — and, since a citations array can outgrow
 * that, hold at an unclosed `CITATIONS:[` until it closes (within a cap).
 *
 * At stream end we parse the held-back tail, emit any remaining prose, and —
 * if perplexity citations were collected — append a Markdown sources block
 * as one final delta before the `[DONE]` terminator. Cancelling the stream
 * (client gone) cancels the upstream read.
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

  const reader = body.getReader();

  return new ReadableStream({
    async start(controller) {
      let pending = "";
      const citations: string[] = [];
      // Until the head of the stream is known not to be (or no longer to be) a
      // leading CHAT_ID sentinel, flush nothing.
      let head = true;

      controller.enqueue(sse({ role: "assistant" }));

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          pending += decoder.decode(value, { stream: true });

          if (head) {
            if (PARTIAL_LEADING_RE.test(pending)) continue;
            pending = pending.replace(LEADING_SENTINEL_RE, "");
            head = false;
          }

          pending = cutMarkers(pending, citations);
          const boundary = flushBoundary(pending);
          if (boundary > 0) {
            const out = pending.slice(0, boundary);
            pending = pending.slice(boundary);
            controller.enqueue(sse({ content: out }));
          }
        }

        pending += decoder.decode();
        // Past the head, a sentinel at the start of the tail is not leading.
        const tail = head ? parseTrailers(pending) : parseTail(pending);
        if (tail.content) controller.enqueue(sse({ content: tail.content }));
        const sources = formatCitations([...citations, ...tail.citations]);
        if (sources) controller.enqueue(sse({ content: sources }));

        controller.enqueue(sse({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    // The client went away: stop reading so upstream can stop generating.
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Cut complete markers out of the buffer, collecting citations. */
function cutMarkers(pending: string, citations: string[]): string {
  let out = pending;
  const cm = CITATIONS_RE.exec(out);
  const parsed = cm?.[1] ? safeParseStringArray(cm[1]) : null;
  if (cm && parsed) {
    citations.push(...parsed);
    out = out.slice(0, cm.index) + out.slice(cm.index + cm[0].length);
  }
  const sm = STREAM_SENTINEL_RE.exec(out);
  if (sm) out = out.slice(0, sm.index) + out.slice(sm.index + sm[0].length);
  return out;
}

function flushBoundary(pending: string): number {
  let cut = Math.max(0, pending.length - HOLDBACK_CHARS);
  // An unclosed array is held — but only so far: past MAX_CITATIONS_CHARS it
  // is prose that happens to say `CITATIONS:[`, and holding it until EOF would
  // rescan an ever-growing buffer on every chunk.
  const citIdx = pending.indexOf(CITATIONS_MARKER);
  if (
    citIdx >= 0 &&
    pending.length - citIdx < MAX_CITATIONS_CHARS &&
    !pending.includes("]", citIdx)
  ) {
    cut = Math.min(cut, citIdx);
  }
  // Never split a surrogate pair: a lone half breaks clients that decode each
  // chunk on its own (Python's openai SDK raises on encode).
  const code = pending.charCodeAt(cut - 1);
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}
