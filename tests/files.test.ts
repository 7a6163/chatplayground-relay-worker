import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/error-handler";
import files from "../src/routes/files";

// /v1/files needs no upstream credential, so auth never runs here — the route
// forwards the raw multipart body straight to the temp-file host.

const env = {
  UPSTREAM_UPLOAD_URL: "https://up.example.test/api/upload",
  UPSTREAM_ORIGIN: "https://web.example.test",
  UPSTREAM_REFERER: "https://web.example.test/",
};

const MULTIPART = "multipart/form-data; boundary=----x";

function post(headers: Record<string, string>, body?: string) {
  // oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
  const app = new Hono<any>();
  app.onError(errorHandler);
  app.route("/", files);
  return app.request("/v1/files", { method: "POST", headers, body }, env);
}

async function envelope(res: Response) {
  const body = (await res.json()) as { error: { message: string } };
  return body.error;
}

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/files", () => {
  it("rejects a non-multipart content-type without calling upstream", async () => {
    vi.spyOn(globalThis, "fetch");
    const res = await post({ "content-type": "application/json" }, "{}");
    expect(res.status).toBe(400);
    expect((await envelope(res)).message).toContain("multipart/form-data");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a multipart request with no body", async () => {
    vi.spyOn(globalThis, "fetch");
    const res = await post({ "content-type": MULTIPART });
    expect(res.status).toBe(400);
    expect((await envelope(res)).message).toBe("Request body is empty.");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("forwards the body and returns the URL as the file id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ url: "https://files.example.test/abc.png" }),
    );

    const res = await post(
      { "content-type": MULTIPART, "content-length": "2048" },
      "------x--",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "https://files.example.test/abc.png",
      object: "file",
      bytes: 2048,
      purpose: "vision",
      status: "processed",
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(env.UPSTREAM_UPLOAD_URL);
    const headers = init.headers as Record<string, string>;
    // The boundary has to survive verbatim or upstream can't parse the body.
    expect(headers["content-type"]).toBe(MULTIPART);
    expect(headers.origin).toBe(env.UPSTREAM_ORIGIN);
    // No credential: this host is unauthenticated.
    expect(headers.authorization).toBeUndefined();
  });

  it("reports 0 bytes rather than NaN when content-length is unusable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ url: "https://files.example.test/abc.png" }),
    );
    const res = await post(
      { "content-type": MULTIPART, "content-length": "not-a-number" },
      "------x--",
    );
    expect(((await res.json()) as { bytes: number }).bytes).toBe(0);
  });

  it("maps an upstream failure through upstreamError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );
    const res = await post({ "content-type": MULTIPART }, "------x--");
    expect(res.status).toBe(502);
    expect((await envelope(res)).message).toContain("upstream returned 500");
  });

  it("502s when upstream accepts the upload but returns no URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    const res = await post({ "content-type": MULTIPART }, "------x--");
    expect(res.status).toBe(502);
    expect((await envelope(res)).message).toContain("did not return a URL");
  });
});
