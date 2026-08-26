import { describe, expect, it } from "vitest";
import { upstreamError } from "../src/utils/errors";

describe("upstreamError", () => {
  // 502 makes OpenAI clients retry with backoff; a permission failure never
  // succeeds on retry, so 401/403 must keep their own terminal status.
  it("passes 401/403 through instead of masking them as 502", () => {
    expect(upstreamError(403, "x").status).toBe(403);
    expect(upstreamError(403, "x").type).toBe("permission_denied");
    expect(upstreamError(401, "x").status).toBe(401);
  });

  it("still maps other upstream failures to 502", () => {
    for (const s of [500, 502, 503, 429]) {
      expect(upstreamError(s, "x").status).toBe(502);
      expect(upstreamError(s, "x").type).toBe("upstream_error");
    }
  });

  it("keeps the upstream status in the error code either way", () => {
    expect(upstreamError(403, "x").code).toBe("upstream_403");
    expect(upstreamError(503, "x").code).toBe("upstream_503");
  });
});
