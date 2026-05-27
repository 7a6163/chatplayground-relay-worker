// Seed registry — placeholder until model discovery extracts the
// authoritative list from web.chatplayground.ai's bundle.
//
// Note: upstreamBotId is NOT always the bare suffix of upstreamModel.
// Captured examples:
//   model="openai/gpt-5.5"               botId="gpt-5.5"
//   model="google/gemini-3-flash-preview" botId="gemini-3-flash"
// Always carry both fields independently.

export interface ModelEntry {
  id: string; // public id callers use (mirrors upstreamBotId)
  modelName: string; // bare model name, e.g. "gpt-5.5" / "sonar-pro"
  upstreamModel: string; // full slug, e.g. "google/gemini-3-flash-preview"
  upstreamBotId: string; // short id, e.g. "gemini-3-flash"
  provider: string; // "google"
}

function m(provider: string, model: string, botId?: string): ModelEntry {
  const bot = botId ?? model;
  return {
    id: bot,
    modelName: model,
    upstreamModel: `${provider}/${model}`,
    upstreamBotId: bot,
    provider,
  };
}

export const SEED_MODELS: ModelEntry[] = [
  // Confirmed via Burp capture:
  m("openai", "gpt-5.5"),
  m("openai", "gpt-5.4"),
  m("google", "gemini-3-flash-preview", "gemini-3-flash"),

  // Likely-supported placeholders (replace with bundle-derived list):
  m("openai", "gpt-4o"),
  m("openai", "gpt-4o-mini"),
  m("anthropic", "claude-4.6-sonnet"),
  m("anthropic", "claude-4-opus"),
  m("google", "gemini-3-pro"),
  m("xai", "grok-3"),
  m("deepseek", "deepseek-v3"),
];
