// chatplayground.ai /api/chat/azure request body shape.
// Captured from production traffic (Burp). Supports both plain-text and
// multimodal (OpenAI-style content-part array) messages.

export interface UpstreamContentPartText {
  type: "text";
  text: string;
}

export interface UpstreamContentPartImage {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type UpstreamContentPart =
  | UpstreamContentPartText
  | UpstreamContentPartImage;

export type UpstreamMessageContent = string | UpstreamContentPart[];

export interface UpstreamMessage {
  role: "system" | "user" | "assistant";
  content: UpstreamMessageContent;
}

export interface UpstreamChatRequest {
  messages: UpstreamMessage[];
  model: string; // full slug, e.g. "google/gemini-3-flash-preview"
  chatId: string; // CUID, or "" for a fresh chat
  isRegenerate: boolean;
  promptTemplate: null;
  fileUrl: null;
  botId: string; // short id, e.g. "gemini-3-flash"
  noSave: boolean;
}
