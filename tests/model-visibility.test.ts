import { describe, expect, it } from "vitest";
import type { ModelEntry } from "../src/constants/models";
import { isVisible } from "../src/utils/model-discovery";

const entry = (premiumOnly?: boolean): ModelEntry => ({
  id: "m",
  modelName: "m",
  upstreamModel: "p/m",
  upstreamBotId: "m",
  provider: "p",
  endpoint: "azure",
  premiumOnly,
});

describe("isVisible", () => {
  it("hides premium models by default", () => {
    expect(isVisible(entry(true), {})).toBe(false);
    expect(isVisible(entry(false), {})).toBe(true);
  });

  it("shows everything when PREMIUM_MODELS is exactly \"true\"", () => {
    expect(isVisible(entry(true), { PREMIUM_MODELS: "true" })).toBe(true);
  });

  // wrangler vars are strings, so a truthy-check would leak on "false"
  it("treats any other string as off", () => {
    expect(isVisible(entry(true), { PREMIUM_MODELS: "false" })).toBe(false);
    expect(isVisible(entry(true), { PREMIUM_MODELS: "1" })).toBe(false);
  });

  // SEED_MODELS entries carry no flag; they must stay visible
  it("treats a missing flag as non-premium", () => {
    expect(isVisible(entry(undefined), {})).toBe(true);
  });
});
