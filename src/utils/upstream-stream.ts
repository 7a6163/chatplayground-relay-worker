import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
} from "../types/openai";

// chatplayground appends `CHAT_ID:<cuid>` at the very end of the stream as a
// sentinel. CUID format: `c` + 24 chars of [a-z0-9]. We strip it before
// emitting content. Allow ≥20 to be lenient.
const SENTINEL_RE = /CHAT_ID:(c[a-z0-9]{20,})$/;
const HOLDBACK_CHARS = 100;

export interface ParsedUpstream {
  content: string;
  chatId: string | null;
}

/** Read entire upstream body, strip sentinel, return content + chatId. */
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
  return splitSentinel(buf);
}

export function splitSentinel(buf: string): ParsedUpstream {
  const match = SENTINEL_RE.exec(buf);
  if (!match) return { content: buf, chatId: null };
  return { content: buf.slice(0, match.index), chatId: match[1] ?? null };
}

interface ChunkMeta {
  id: string;
  model: string;
  created: number;
}

/**
 * Wrap upstream text stream as OpenAI-format chat.completion.chunk SSE.
 * Holds back the trailing HOLDBACK_CHARS so a partial sentinel never leaks
 * to the caller. Emits a `[DONE]` terminator.
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

          if (pending.length > HOLDBACK_CHARS) {
            const flushLen = pending.length - HOLDBACK_CHARS;
            const out = pending.slice(0, flushLen);
            pending = pending.slice(flushLen);
            controller.enqueue(sse({ content: out }));
          }
        }

        pending += decoder.decode();
        const { content } = splitSentinel(pending);
        if (content) controller.enqueue(sse({ content }));

        controller.enqueue(sse({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
