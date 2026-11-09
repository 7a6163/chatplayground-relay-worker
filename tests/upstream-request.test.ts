import { describe, expect, it } from "vitest";
import type { ModelEntry } from "../src/constants/models";
import { buildUpstreamRequest } from "../src/utils/upstream-request";

const MODEL: ModelEntry = { id: "gpt-6.1-sol", provider: "openai" };
const hi = {
  model: "gpt-6.1-sol",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("buildUpstreamRequest", () => {
  it("sends the slug, the text and noSave by default, with no conversationId", () => {
    const body = buildUpstreamRequest(hi, MODEL);
    expect(body).toEqual({
      modelSlug: "gpt-6.1-sol",
      submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: { text: "hi" },
      noSave: true,
    });
  });

  it("uses a fresh submissionId per call", () => {
    const a = buildUpstreamRequest(hi, MODEL).submissionId;
    expect(buildUpstreamRequest(hi, MODEL).submissionId).not.toBe(a);
  });

  it("maps metadata.save → !noSave and user → conversationId", () => {
    const body = buildUpstreamRequest(
      { ...hi, metadata: { save: true }, user: "01a1bebe-a301" },
      MODEL,
    );
    expect(body.noSave).toBe(false);
    expect(body.conversationId).toBe("01a1bebe-a301");
  });
});
