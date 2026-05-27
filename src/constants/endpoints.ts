// chatplayground routes each chat model to one of three upstream endpoints,
// keyed solely on the model's botId. This mirrors the frontend's routing
// factory verbatim (bundle `rit(botId)`):
//
//   AZURE_BOT_IDS.includes(botId) ? azure
//     : botId.includes("perplexity") ? perplexity
//     : lmsys
//
// Coupling note: AZURE_BOT_IDS is hardcoded in chatplayground's bundle and can
// change on their deploys. If a model starts 4xx-ing after an upstream change,
// re-run `node scripts/probe-endpoints.mjs` and reconcile this list.

export type UpstreamEndpoint = "azure" | "perplexity" | "lmsys";

// The azure allowlist, copied from the bundle routing factory.
const AZURE_BOT_IDS: ReadonlySet<string> = new Set([
  "chatgptPro",
  "o3-mini",
  "o4-mini",
  "gpt-5",
  "gpt-5.1-chat",
  "gpt-5.2-chat",
  "gpt-5.3-chat",
  "gpt-5.4",
  "gpt-5.5",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "gemini-3.1-pro-preview",
  "gemini-3-flash",
  "grok-4-1-fast-non-reasoning",
  "grok-4-20-non-reasoning",
  "deepseek-r1",
  "deepseek-v3.2",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "mistral-large-3",
  "kimi-k2.5",
  "kimi-k2.6",
]);

export function resolveEndpoint(botId: string): UpstreamEndpoint {
  if (AZURE_BOT_IDS.has(botId)) return "azure";
  if (botId.includes("perplexity")) return "perplexity";
  return "lmsys";
}
