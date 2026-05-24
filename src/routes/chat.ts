import { Hono } from "hono";
import { CHAT_TIMEOUT } from "../constants/timeouts";
import type { Env, Variables } from "../types/env";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionUsage,
  OpenAIMessage,
} from "../types/openai";
import {
  invalidRequest,
  modelNotFound,
  upstreamError,
} from "../utils/errors";
import { getModels } from "../utils/model-discovery";
import { findModel } from "../utils/model-id";
import {
  buildUpstreamHeaders,
  buildUpstreamRequest,
} from "../utils/upstream-request";
import {
  collectUpstream,
  streamUpstreamAsOpenAI,
} from "../utils/upstream-stream";

const chat = new Hono<{ Bindings: Env; Variables: Variables }>();

chat.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | ChatCompletionRequest
    | null;

  if (!body || typeof body !== "object") {
    throw invalidRequest("Request body must be JSON.");
  }
  if (!body.model || typeof body.model !== "string") {
    throw invalidRequest("'model' is required.", "model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest("'messages' must be a non-empty array.", "messages");
  }

  const registry = await getModels(c.env);
  const model = findModel(body.model, registry);
  if (!model) throw modelNotFound(body.model);

  const upstreamBody = buildUpstreamRequest(body, model);
  const clerkUserId = c.get("clerkUserId");

  const upstream = await fetch(c.env.UPSTREAM_CHAT_URL, {
    method: "POST",
    headers: buildUpstreamHeaders(clerkUserId, c.env),
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(CHAT_TIMEOUT),
  });

  if (!upstream.ok || !upstream.body) {
    throw upstreamError(
      upstream.status,
      `Upstream returned ${upstream.status}. Most likely cause: invalid X-Clerk-User-Id, unsupported model, or upstream outage.`,
    );
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    const sse = streamUpstreamAsOpenAI(upstream.body, {
      id,
      model: model.id,
      created,
    });
    return new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  }

  const { content } = await collectUpstream(upstream.body);

  const response: ChatCompletionResponse = {
    id,
    object: "chat.completion",
    created,
    model: model.id,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: estimateUsage(body.messages, content),
  };

  return Response.json(response);
});

// Crude usage estimate — chatplayground doesn't return token counts.
// ~4 chars per token. Multimodal content parts count text only.
function estimateUsage(
  messages: OpenAIMessage[],
  completion: string,
): ChatCompletionUsage {
  const promptChars = messages.reduce(
    (sum, m) => sum + textChars(m.content),
    0,
  );
  const prompt = Math.ceil(promptChars / 4);
  const comp = Math.ceil(completion.length / 4);
  return {
    prompt_tokens: prompt,
    completion_tokens: comp,
    total_tokens: prompt + comp,
  };
}

function textChars(content: OpenAIMessage["content"]): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const part of content) {
    if (part.type === "text") n += part.text.length;
  }
  return n;
}

export default chat;
