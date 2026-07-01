import { SEED_MODELS, type ModelEntry } from "../constants/models";

/**
 * Resolve a caller-supplied model id.
 * Accepts bare ("gemini-3-flash") or provider-prefixed
 * ("google/gemini-3-flash-preview"). Unknown but well-formed
 * "provider/id" inputs pass through so callers can use models the registry
 * hasn't been updated for yet.
 */
export function findModel(
  input: string,
  registry: ModelEntry[] = SEED_MODELS,
): ModelEntry | null {
  for (const entry of registry) {
    if (entry.id === input || entry.upstreamModel === input) return entry;
  }

  const slash = input.indexOf("/");
  if (slash > 0) {
    const provider = input.slice(0, slash);
    const id = input.slice(slash + 1);
    if (provider && id) {
      return {
        id,
        modelName: id,
        upstreamModel: input,
        upstreamBotId: id,
        provider,
        endpoint: "lmsys", // unknown passthrough → lmsys catch-all
      };
    }
  }

  return null;
}
