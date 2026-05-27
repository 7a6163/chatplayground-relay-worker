import { describe, expect, it } from "vitest";
import { resolveEndpoint } from "../src/constants/endpoints";
import type { ModelEntry } from "../src/constants/models";
import type { ChatCompletionRequest } from "../src/types/openai";
import {
  buildUpstreamRequest,
  endpointUrl,
} from "../src/utils/upstream-request";

// gpt-5.5 is in the azure allowlist.
const AZURE_MODEL: ModelEntry = {
  id: "gpt-5.5",
  modelName: "gpt-5.5",
  upstreamModel: "openai/gpt-5.5",
  upstreamBotId: "gpt-5.5",
  provider: "openai",
};

// botId contains "perplexity" → perplexity endpoint.
const PERPLEXITY_MODEL: ModelEntry = {
  id: "perplexity-sonar-pro",
  modelName: "sonar-pro",
  upstreamModel: "perplexity/sonar-pro",
  upstreamBotId: "perplexity-sonar-pro",
  provider: "perplexity",
};

// Not in the allowlist and no "perplexity" → lmsys fallback.
const LMSYS_MODEL: ModelEntry = {
  id: "llama-4-scout",
  modelName: "llama-4-scout",
  upstreamModel: "meta/llama-4-scout",
  upstreamBotId: "llama-4-scout",
  provider: "meta",
};

const AZURE_BASE_URL = "https://app.chatplayground.ai/api/chat/azure";

describe("buildUpstreamRequest — field mapping", () => {
  it("defaults to noSave=true and empty chatId", () => {
    const { body } = buildUpstreamRequest(
      { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
      AZURE_MODEL,
    );
    expect(body.noSave).toBe(true);
    expect(body.chatId).toBe("");
    expect(body.botId).toBe("gpt-5.5");
  });

  it("maps metadata.save → !noSave and user → chatId", () => {
    const { body } = buildUpstreamRequest(
      {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        metadata: { save: true },
        user: "ck_existing_chat_id",
      },
      AZURE_MODEL,
    );
    expect(body.noSave).toBe(false);
    expect(body.chatId).toBe("ck_existing_chat_id");
  });
});

describe("buildUpstreamRequest — per-endpoint body shape", () => {
  const req: ChatCompletionRequest = {
    model: "x",
    messages: [{ role: "user", content: "hi" }],
  };

  it("azure: model is the provider/model slug, no apiKey", () => {
    const { endpoint, body } = buildUpstreamRequest(req, AZURE_MODEL);
    expect(endpoint).toBe("azure");
    expect(body).toMatchObject({ model: "openai/gpt-5.5" });
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("modelName");
  });

  it("perplexity: bare modelName + apiKey:null, no `model` field", () => {
    const { endpoint, body } = buildUpstreamRequest(req, PERPLEXITY_MODEL);
    expect(endpoint).toBe("perplexity");
    expect(body).not.toHaveProperty("model");
    expect(Object.keys(body).sort()).toEqual([
      "apiKey",
      "botId",
      "chatId",
      "fileUrl",
      "isRegenerate",
      "messages",
      "modelName",
      "noSave",
      "promptTemplate",
    ]);
    expect(body).toMatchObject({
      modelName: "sonar-pro",
      apiKey: null,
      botId: "perplexity-sonar-pro",
    });
  });

  it("lmsys: bare name in `model` + apiKey:null (not the slug)", () => {
    const { endpoint, body } = buildUpstreamRequest(req, LMSYS_MODEL);
    expect(endpoint).toBe("lmsys");
    expect(body).toMatchObject({ model: "llama-4-scout", apiKey: null });
    // The bare name, not the "meta/llama-4-scout" slug.
    expect((body as { model: string }).model).not.toContain("/");
  });
});

describe("resolveEndpoint", () => {
  it("routes allowlisted botIds to azure", () => {
    expect(resolveEndpoint("gpt-5.5")).toBe("azure");
    expect(resolveEndpoint("kimi-k2.6")).toBe("azure");
    expect(resolveEndpoint("claude-haiku-4-5")).toBe("azure");
  });

  it("routes botIds containing 'perplexity' to perplexity", () => {
    expect(resolveEndpoint("perplexity-sonar-pro")).toBe("perplexity");
    expect(resolveEndpoint("perplexity-sonar-reasoning")).toBe("perplexity");
  });

  it("falls back to lmsys for everything else", () => {
    expect(resolveEndpoint("llama-4-scout")).toBe("lmsys");
    expect(resolveEndpoint("some-unknown-model")).toBe("lmsys");
  });
});

describe("endpointUrl", () => {
  it("resolves each endpoint as a sibling of the configured azure URL", () => {
    expect(endpointUrl("azure", AZURE_BASE_URL)).toBe(AZURE_BASE_URL);
    expect(endpointUrl("perplexity", AZURE_BASE_URL)).toBe(
      "https://app.chatplayground.ai/api/chat/perplexity",
    );
    expect(endpointUrl("lmsys", AZURE_BASE_URL)).toBe(
      "https://app.chatplayground.ai/api/chat/lmsys",
    );
  });
});
