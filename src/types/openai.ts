// OpenAI-compatible API shapes. Permissive on input; only fields we honor
// are typed strictly.

export interface OpenAIContentPartText {
  type: "text";
  text: string;
}

export interface OpenAIContentPartImage {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type OpenAIContentPart =
  | OpenAIContentPartText
  | OpenAIContentPartImage;

export type OpenAIMessageContent = string | OpenAIContentPart[];

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: OpenAIMessageContent;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  // OpenAI extension fields we honor:
  user?: string; // → chatplayground chatId (continue same chat)
  metadata?: { save?: boolean }; // → !noSave (default: noSave=true)
  // Fields accepted-and-ignored (no upstream equivalent):
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop";
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: "stop" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ModelListItem {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelListItem[];
}

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string | null;
    param: string | null;
  };
}
