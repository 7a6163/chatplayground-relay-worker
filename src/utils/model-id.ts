import type { ModelEntry } from "../constants/models";

/**
 * Resolve a caller-supplied model id.
 * Accepts bare ("gpt-6.1-sol") or provider-prefixed ("openai/gpt-6.1-sol").
 * Unknown but well-formed "provider/slug" inputs pass through as that slug so
 * callers can use models the registry hasn't been updated for yet.
 */
export function findModel(
  input: string,
  registry: ModelEntry[],
): ModelEntry | null {
  for (const entry of registry) {
    if (entry.id === input || `${entry.provider}/${entry.id}` === input)
      return entry;
  }

  const slash = input.indexOf("/");
  if (slash > 0) {
    const provider = input.slice(0, slash);
    const id = input.slice(slash + 1);
    if (provider && id) return { id, provider };
  }

  return null;
}
