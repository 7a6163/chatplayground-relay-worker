import type { ModelEntry } from "../constants/models";
import type { ChatCompletionRequest } from "../types/openai";
import type { UpstreamChatRequest, UpstreamMessage } from "../types/upstream";

export function buildUpstreamRequest(
  req: ChatCompletionRequest,
  model: ModelEntry,
): UpstreamChatRequest {
  // chatplayground accepts the same content shape as OpenAI (string or
  // ContentPart[]), so we pass `content` through unchanged. The only
  // role normalization: collapse "tool" → "user" (chatplayground has no
  // tool role in its azure endpoint).
  const messages: UpstreamMessage[] = req.messages.map((msg) => ({
    role: msg.role === "tool" ? "user" : msg.role,
    content: msg.content,
  }));

  // OpenAI `metadata.save` extension → !noSave. Default: don't pollute the
  // caller's chatplayground history with API traffic (noSave=true).
  const save = req.metadata?.save ?? false;

  return {
    messages,
    model: model.upstreamModel,
    chatId: req.user ?? "", // OpenAI `user` → chatplayground `chatId`
    isRegenerate: false,
    promptTemplate: null,
    fileUrl: null,
    botId: model.upstreamBotId,
    noSave: !save,
  };
}

export interface UpstreamHeaderEnv {
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
}

export function buildUpstreamHeaders(
  clerkUserId: string,
  env: UpstreamHeaderEnv,
): HeadersInit {
  // text/plain bypasses CORS preflight — chatplayground's frontend uses this
  // exact content-type and the backend enforces it.
  return {
    "content-type": "text/plain;charset=UTF-8",
    "x-clerk-user-id": clerkUserId,
    origin: env.UPSTREAM_ORIGIN,
    referer: env.UPSTREAM_REFERER,
    accept: "*/*",
  };
}
