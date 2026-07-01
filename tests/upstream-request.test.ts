import { describe, expect, it } from "vitest";
import { toEndpoint } from "../src/constants/endpoints";
import type { ModelEntry } from "../src/constants/models";
import type { ChatCompletionRequest } from "../src/types/openai";
import {
  buildUpstreamRequest,
  endpointUrl,
} from "../src/utils/upstream-request";

const AZURE_MODEL: ModelEntry = {
  id: "gpt-5.5",
  modelName: "gpt-5.5",
  upstreamModel: "openai/gpt-5.5",
  upstreamBotId: "gpt-5.5",
  provider: "openai",
  endpoint: "azure",
};

const PERPLEXITY_MODEL: ModelEntry = {
  id: "perplexity-sonar-pro",
  modelName: "sonar-pro",
  upstreamModel: "perplexity/sonar-pro",
  upstreamBotId: "perplexity-sonar-pro",
  provider: "perplexity",
  endpoint: "perplexity",
};

// lmsys modelName is a full provider slug (with a slash) in the live feed.
const LMSYS_MODEL: ModelEntry = {
  id: "llama-4-scout",
  modelName: "meta-llama/llama-4-scout-17b-16e-instruct",
  upstreamModel: "meta/meta-llama/llama-4-scout-17b-16e-instruct",
  upstreamBotId: "llama-4-scout",
  provider: "meta",
  endpoint: "lmsys",
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

  it("lmsys: modelName passed through in `model` + apiKey:null", () => {
    const { endpoint, body } = buildUpstreamRequest(req, LMSYS_MODEL);
    expect(endpoint).toBe("lmsys");
    expect(body).toMatchObject({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      apiKey: null,
    });
    expect(body).not.toHaveProperty("modelName");
  });
});

describe("toEndpoint", () => {
  it("passes through the three known endpoints", () => {
    expect(toEndpoint("azure")).toBe("azure");
    expect(toEndpoint("perplexity")).toBe("perplexity");
    expect(toEndpoint("lmsys")).toBe("lmsys");
  });

  it("defaults unknown endpoint values to lmsys", () => {
    expect(toEndpoint("something-new")).toBe("lmsys");
    expect(toEndpoint("")).toBe("lmsys");
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
