// Shape of one entry in the model registry.
//
// There is deliberately no hardcoded fallback list here: it would be a copy of
// data that lives upstream, so it rots silently and only gets used on the day
// discovery is already broken. Discovery failure now surfaces as a 503 instead.
//
// Note: upstreamBotId is NOT always the bare suffix of upstreamModel. Captured:
//   model="openai/gpt-5.6-luna"  botId="gpt-5.6-luna"   (the usual case)
//   model="perplexity/sonar"     botId="perplexity-sonar"
// Always carry both fields independently.

import type { UpstreamEndpoint } from "./endpoints";

export interface ModelEntry {
  id: string; // public id callers use (mirrors upstreamBotId)
  modelName: string; // bare model name, e.g. "gpt-5.6-luna" / "sonar"
  upstreamModel: string; // full slug, e.g. "perplexity/sonar"
  upstreamBotId: string; // short id, e.g. "perplexity-sonar"
  provider: string; // "perplexity"
  endpoint: UpstreamEndpoint; // which /api/chat/* endpoint serves this model
  premiumOnly?: boolean; // upstream 403s these without a premium account
}
