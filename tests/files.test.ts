import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auth } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/error-handler";
import files from "../src/routes/files";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2ln-bmF0dXJl";
const env = {
  UPSTREAM_CHAT_URL: "https://up.example.test/api/chat",
  UPSTREAM_ORIGIN: "https://web.example.test",
  UPSTREAM_REFERER: "https://web.example.test/",
};

function post(body: BodyInit, headers: Record<string, string> = {}) {
  // oxlint-disable-next-line typescript/no-explicit-any -- minimal test env stub
  const app = new Hono<any>();
  app.onError(errorHandler);
  app.use("/v1/*", auth);
  app.route("/", files);
  return app.request(
    "/v1/files",
    {
      method: "POST",
      headers: { authorization: `Bearer ${JWT}`, ...headers },
      body,
    },
    env,
  );
}

function form(file?: Blob, name = "red.png") {
  const fd = new FormData();
  fd.append("purpose", "vision");
  if (file) fd.append("file", file, name);
  return fd;
}

async function envelope(res: Response) {
  return ((await res.json()) as { error: { message: string } }).error;
}

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/files", () => {
  it("rejects a non-multipart content-type without calling upstream", async () => {
    vi.spyOn(globalThis, "fetch");
    const res = await post("{}", { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect((await envelope(res)).message).toContain("multipart/form-data");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a multipart body with no file field", async () => {
    vi.spyOn(globalThis, "fetch");
    const res = await post(form());
    expect(res.status).toBe(400);
    expect((await envelope(res)).message).toContain("'file'");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("uploads through upstream's flow and returns the fileId as the id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/presign")) {
        return Response.json({
          fileId: "f1",
          uploadUrl: "https://r2.test/put",
          headers: {},
        });
      }
      if (url.endsWith("/complete")) return Response.json({ id: "f1" });
      return new Response(null);
    });

    const res = await post(
      form(new Blob([new Uint8Array(5)], { type: "image/png" })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "f1",
      object: "file",
      bytes: 5,
      filename: "red.png",
      purpose: "vision",
      status: "processed",
    });
    const presign = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(presign[1].headers).toMatchObject({
      authorization: `Bearer ${JWT}`,
    });
  });

  it("400s a file that isn't a supported image", async () => {
    vi.spyOn(globalThis, "fetch");
    const res = await post(
      form(new Blob(["%PDF"], { type: "application/pdf" }), "a.pdf"),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
