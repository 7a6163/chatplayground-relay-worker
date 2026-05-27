import { resolveEndpoint, type UpstreamEndpoint } from "../constants/endpoints";
import type { ModelEntry } from "../constants/models";
import type { ChatCompletionRequest } from "../types/openai";
import type { UpstreamChatRequest, UpstreamMessage } from "../types/upstream";

export interface BuiltUpstreamRequest {
  endpoint: UpstreamEndpoint;
  body: UpstreamChatRequest;
}

export function buildUpstreamRequest(
  req: ChatCompletionRequest,
  model: ModelEntry,
): BuiltUpstreamRequest {
  // chatplayground accepts the same content shape as OpenAI (string or
  // ContentPart[]), so we pass `content` through unchanged. The only
  // role normalization: collapse "tool" → "user" (no endpoint has a tool role).
  const messages: UpstreamMessage[] = req.messages.map((msg) => ({
    role: msg.role === "tool" ? "user" : msg.role,
    content: msg.content,
  }));

  // OpenAI `metadata.save` extension → !noSave. Default: don't pollute the
  // caller's chatplayground history with API traffic (noSave=true).
  const save = req.metadata?.save ?? false;

  // Fields shared by all three endpoints.
  const base = {
    messages,
    chatId: req.user ?? "", // OpenAI `user` → chatplayground `chatId`
    isRegenerate: false,
    promptTemplate: null,
    fileUrl: null,
    botId: model.upstreamBotId,
    noSave: !save,
  };

  // The model identifier field differs per endpoint (see types/upstream.ts):
  // azure wants the provider/model slug; perplexity wants a bare modelName;
  // lmsys wants the bare name in `model`. perplexity/lmsys also take an
  // apiKey — null means "use chatplayground's own upstream key" (the relay
  // is BYO-less, so always null).
  const endpoint = resolveEndpoint(model.upstreamBotId);
  switch (endpoint) {
    case "azure":
      return { endpoint, body: { ...base, model: model.upstreamModel } };
    case "perplexity":
      return {
        endpoint,
        body: { ...base, modelName: model.modelName, apiKey: null },
      };
    case "lmsys":
      return {
        endpoint,
        body: { ...base, model: model.modelName, apiKey: null },
      };
  }
}

export function endpointUrl(
  endpoint: UpstreamEndpoint,
  baseChatUrl: string,
): string {
  // The three chat endpoints are siblings under /api/chat/. Resolving the
  // endpoint name relative to the configured azure URL yields the others, so
  // a single UPSTREAM_CHAT_URL var repoints the whole set at one instance.
  return new URL(endpoint, baseChatUrl).toString();
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
