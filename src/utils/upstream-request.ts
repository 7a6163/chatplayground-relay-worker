import type { UpstreamEndpoint } from "../constants/endpoints";
import type { ModelEntry } from "../constants/models";
import type { ChatCompletionRequest, OpenAIMessage } from "../types/openai";
import type {
  UpstreamChatRequest,
  UpstreamContentPart,
  UpstreamContentPartText,
  UpstreamMessage,
} from "../types/upstream";

export interface BuiltUpstreamRequest {
  endpoint: UpstreamEndpoint;
  body: UpstreamChatRequest;
}

export function buildUpstreamRequest(
  req: ChatCompletionRequest,
  model: ModelEntry,
): BuiltUpstreamRequest {
  const messages = collapseHistory(req.messages);

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
  const endpoint = model.endpoint;
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

const ROLE_LABEL = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
} as const;

/**
 * Upstream now 400s on more than one message ("Send only the new prompt.
 * Conversation history is not accepted.") — the web client sends only the new
 * turn and lets `chatId` carry history server-side. The relay is stateless, so
 * fold the OpenAI history into one user turn as a role-labelled transcript.
 * Content parts pass through unchanged (same shape as OpenAI), images in place.
 */
function collapseHistory(messages: OpenAIMessage[]): UpstreamMessage[] {
  const [only] = messages;
  if (messages.length === 1 && only) {
    // No endpoint has a tool role.
    return [
      {
        role: only.role === "tool" ? "user" : only.role,
        content: only.content,
      },
    ];
  }

  const parts: UpstreamContentPart[] = [];
  for (const m of messages) {
    const label = ROLE_LABEL[m.role];
    if (typeof m.content === "string") {
      parts.push({ type: "text", text: `${label}: ${m.content}` });
    } else {
      parts.push({ type: "text", text: `${label}:` }, ...m.content);
    }
  }

  const text = parts.every((p) => p.type === "text");
  return [
    {
      role: "user",
      content: text
        ? parts.map((p) => (p as UpstreamContentPartText).text).join("\n\n")
        : parts,
    },
  ];
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
  sessionToken: string,
  env: UpstreamHeaderEnv,
): HeadersInit {
  // text/plain bypasses CORS preflight — chatplayground's frontend uses this
  // exact content-type and the backend enforces it.
  return {
    "content-type": "text/plain;charset=UTF-8",
    authorization: `Bearer ${sessionToken}`,
    origin: env.UPSTREAM_ORIGIN,
    referer: env.UPSTREAM_REFERER,
    accept: "*/*",
  };
}
