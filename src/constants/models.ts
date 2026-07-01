// Seed registry — safety net used only if live discovery from
// chatplayground's /api/models feed fails. The live feed is authoritative.
//
// Note: upstreamBotId is NOT always the bare suffix of upstreamModel.
// Captured examples:
//   model="openai/gpt-5.5"               botId="gpt-5.5"
//   model="google/gemini-3-flash-preview" botId="gemini-3-flash"
// Always carry both fields independently.

import type { UpstreamEndpoint } from "./endpoints";

export interface ModelEntry {
  id: string; // public id callers use (mirrors upstreamBotId)
  modelName: string; // bare model name, e.g. "gpt-5.5" / "sonar-pro"
  upstreamModel: string; // full slug, e.g. "google/gemini-3-flash-preview"
  upstreamBotId: string; // short id, e.g. "gemini-3-flash"
  provider: string; // "google"
  endpoint: UpstreamEndpoint; // which /api/chat/* endpoint serves this model
}

function m(
  provider: string,
  model: string,
  endpoint: UpstreamEndpoint = "azure",
  botId?: string,
): ModelEntry {
  const bot = botId ?? model;
  return {
    id: bot,
    modelName: model,
    upstreamModel: `${provider}/${model}`,
    upstreamBotId: bot,
    provider,
    endpoint,
  };
}

export const SEED_MODELS: ModelEntry[] = [
  m("openai", "gpt-5.5"),
  m("openai", "gpt-5.4"),
  m("google", "gemini-3-flash-preview", "azure", "gemini-3-flash"),
  m("perplexity", "sonar-pro", "perplexity", "perplexity-sonar-pro"),
];
