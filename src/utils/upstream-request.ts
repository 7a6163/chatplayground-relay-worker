import type { ModelEntry } from "../constants/models";
import type { ChatCompletionRequest, OpenAIMessage } from "../types/openai";
import type { UpstreamChatRequest } from "../types/upstream";
import { invalidRequest } from "./errors";
import { MAX_IMAGES } from "./upstream-upload";

export function buildUpstreamRequest(
  req: ChatCompletionRequest,
  model: ModelEntry,
): UpstreamChatRequest {
  // OpenAI `metadata.save` extension → !noSave. Default: don't pollute the
  // caller's chatplayground history with API traffic (noSave=true).
  const save = req.metadata?.save ?? false;
  return {
    modelSlug: model.id,
    submissionId: crypto.randomUUID(),
    message: { text: collapseHistory(req.messages) },
    // OpenAI `user` → chatplayground conversationId (continue that chat)
    ...(req.user ? { conversationId: req.user } : {}),
    noSave: !save,
  };
}

const ROLE_LABEL = {
  system: "System",
  developer: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
} as const;

/**
 * Upstream takes exactly one new prompt per call and keeps history
 * server-side under `conversationId`. The relay is stateless, so fold the
 * OpenAI history into one prompt as a role-labelled transcript.
 */
function collapseHistory(messages: OpenAIMessage[]): string {
  const [only] = messages;
  if (messages.length === 1 && only) return textOf(only.content);
  return messages
    .map((m) => {
      const text = textOf(m.content);
      return text ? `${ROLE_LABEL[m.role]}: ${text}` : `${ROLE_LABEL[m.role]}:`;
    })
    .join("\n\n");
}

// Image parts travel as `message.attachments` (see imageUrls), not in the text.
function textOf(content: OpenAIMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/**
 * Every image in the conversation, in order. Upstream takes images only as
 * attachments of the one prompt, so a folded history carries all of them.
 */
export function imageUrls(messages: OpenAIMessage[]): string[] {
  const urls = messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.flatMap((p) =>
          p.type === "image_url" ? [p.image_url?.url] : [],
        )
      : [],
  );
  if (urls.some((u) => typeof u !== "string" || !u)) {
    throw invalidRequest(
      "Every image_url part needs an image_url.url.",
      "messages",
    );
  }
  if (urls.length > MAX_IMAGES) {
    throw invalidRequest(
      `At most ${MAX_IMAGES} images per request.`,
      "messages",
    );
  }
  return urls as string[];
}

export interface UpstreamHeaderEnv {
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
}

export function buildUpstreamHeaders(
  sessionToken: string,
  env: UpstreamHeaderEnv,
): HeadersInit {
  // The web client authenticates with the `__session` cookie; verified live
  // that a Bearer header with the same JWT is accepted too.
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${sessionToken}`,
    origin: env.UPSTREAM_ORIGIN,
    referer: env.UPSTREAM_REFERER,
  };
}
