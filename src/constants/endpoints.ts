// chatplayground's /api/models feed tags each model with its serving endpoint
// (azure / perplexity / lmsys). We trust that field directly — no botId
// allowlist. `toEndpoint` guards the untrusted API value at the discovery
// boundary and defaults anything unknown to lmsys (chatplayground's own
// routing fallback for non-azure, non-perplexity bots).

export type UpstreamEndpoint = "azure" | "perplexity" | "lmsys";

const KNOWN: ReadonlySet<string> = new Set(["azure", "perplexity", "lmsys"]);

export function toEndpoint(raw: string): UpstreamEndpoint {
  // ponytail: unknown endpoint → lmsys catch-all, matches upstream's routing
  return KNOWN.has(raw) ? (raw as UpstreamEndpoint) : "lmsys";
}
