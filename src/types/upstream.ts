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

// Fields common to all three chat endpoints (azure / perplexity / lmsys).
// They diverge only in how the model is named and whether an apiKey is sent.
interface UpstreamBodyBase {
  messages: UpstreamMessage[];
  chatId: string; // CUID, or "" for a fresh chat
  isRegenerate: boolean;
  promptTemplate: null;
  fileUrl: null;
  botId: string; // short id, e.g. "gemini-3-flash"
  noSave: boolean;
}

// /api/chat/azure — model is the full slug; no apiKey field.
export interface UpstreamAzureBody extends UpstreamBodyBase {
  model: string; // full slug, e.g. "google/gemini-3-flash-preview"
}

// /api/chat/perplexity — bare modelName + apiKey (null = use upstream's key).
export interface UpstreamPerplexityBody extends UpstreamBodyBase {
  modelName: string; // bare name, e.g. "sonar-pro"
  apiKey: string | null;
}

// /api/chat/lmsys — bare model name in `model` + apiKey.
export interface UpstreamLmsysBody extends UpstreamBodyBase {
  model: string; // bare name, e.g. "llama-4-scout"
  apiKey: string | null;
}

export type UpstreamChatRequest =
  | UpstreamAzureBody
  | UpstreamPerplexityBody
  | UpstreamLmsysBody;
