// Shape of one entry in the model registry.
//
// There is deliberately no hardcoded fallback list here: it would be a copy of
// data that lives upstream, so it rots silently and only gets used on the day
// discovery is already broken. Discovery failure now surfaces as a 503 instead.

export interface ModelEntry {
  id: string; // the feed's `slug` — public id and upstream `modelSlug` alike
  provider: string; // "openai"
  premiumOnly?: boolean; // upstream 403s these without a premium account
}
