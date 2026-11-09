import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
} from "../types/openai";
import type { UpstreamEvent } from "../types/upstream";
import { upstreamError } from "./errors";

export interface UpstreamUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ParsedUpstream {
  content: string;
  citations: readonly string[];
  usage: UpstreamUsage | null; // null when upstream sent no usable counts
}

/**
 * The `data:` events of an upstream reply, in order. Lines that are not
 * `data:` JSON with a string `type` are skipped, `[DONE]` included.
 */
export async function* readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<UpstreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = done ? "" : lines.pop()!; // split() never returns []
    for (const line of lines) {
      const event = parseLine(line);
      if (event) yield event;
    }
    if (done) return;
  }
}

function parseLine(line: string): UpstreamEvent | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" &&
      v !== null &&
      typeof (v as UpstreamEvent).type === "string"
      ? (v as UpstreamEvent)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

function usageOf(e: UpstreamEvent): UpstreamUsage | null {
  const u = e.messageMetadata?.usage;
  if (!u || typeof u.inputTokens !== "number") return null;
  // OpenAI counts reasoning inside completion_tokens; upstream reports it apart.
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens) + num(u.reasoningTokens),
  };
}

/** An `error` event mid-reply. Upstream already answered 200, so it is a 502. */
function replyError(e: UpstreamEvent) {
  return upstreamError(
    502,
    `Upstream failed mid-reply: ${str(e.errorText) ?? "no message"}`,
  );
}

/** Read the whole reply: answer text, source URLs and upstream's usage. */
export async function collectUpstream(
  body: ReadableStream<Uint8Array>,
): Promise<ParsedUpstream> {
  let content = "";
  const citations: string[] = [];
  let usage: UpstreamUsage | null = null;
  for await (const e of readEvents(body.getReader())) {
    if (e.type === "text-delta") content += str(e.delta) ?? "";
    else if (e.type === "source-url" && str(e.url))
      citations.push(e.url as string);
    else if (e.type === "finish") usage = usageOf(e) ?? usage;
    else if (e.type === "error") throw replyError(e);
  }
  return { content, citations, usage };
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
 * Re-emit upstream's text deltas as OpenAI chat.completion.chunk SSE.
 * Reasoning deltas are dropped. Source URLs are collected and appended as one
 * Markdown sources block before the stop chunk. An upstream `error` event
 * becomes an OpenAI-style `{"error": …}` event: the 200 is already sent, so
 * that is the only way left to tell the client why. Cancelling the stream
 * (client gone) cancels the upstream read.
 */
export function streamUpstreamAsOpenAI(
  body: ReadableStream<Uint8Array>,
  meta: ChunkMeta,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const data = (v: unknown) => encoder.encode(`data: ${JSON.stringify(v)}\n\n`);

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
    return data(chunk);
  }

  const reader = body.getReader();

  return new ReadableStream({
    async start(controller) {
      const citations: string[] = [];
      // A delta can end on half a surrogate pair. Hold it for the next one: a
      // lone half breaks clients that decode each chunk on its own (Python's
      // openai SDK raises on encode).
      let held = "";
      controller.enqueue(sse({ role: "assistant" }));

      try {
        for await (const e of readEvents(reader)) {
          if (e.type === "text-delta") {
            let text = held + (str(e.delta) ?? "");
            const last = text.charCodeAt(text.length - 1);
            held = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
            text = held ? text.slice(0, -1) : text;
            if (text) controller.enqueue(sse({ content: text }));
          } else if (e.type === "source-url" && str(e.url)) {
            citations.push(e.url as string);
          } else if (e.type === "error") {
            controller.enqueue(data(replyError(e).toEnvelope()));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
        }

        const tail = held + formatCitations(citations);
        if (tail) controller.enqueue(sse({ content: tail }));
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
