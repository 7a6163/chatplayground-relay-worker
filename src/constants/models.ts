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
  premiumOnly?: boolean; // upstream 403s these without a premium account
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
    // Some feed modelNames already carry a provider slug; mirror discover()
    // and don't double-prefix those.
    upstreamModel: model.includes("/") ? model : `${provider}/${model}`,
    upstreamBotId: bot,
    provider,
    endpoint,
  };
}

// Deliberately all premiumOnly:false — this list is what callers get while
// discovery is already failing, so every entry must be callable by any
// account. Re-check against /api/models when models get retired.
export const SEED_MODELS: ModelEntry[] = [
  m("openai", "gpt-5.6-luna"),
  m("deepseek", "deepseek-v4-flash"),
  m(
    "meta",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "lmsys",
    "llama-4-scout",
  ),
  m("perplexity", "sonar", "perplexity", "perplexity-sonar"),
];
