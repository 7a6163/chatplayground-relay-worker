import { afterEach, describe, expect, it, vi } from "vitest";
import { toFileId, uploadImage } from "../src/utils/upstream-upload";

const env = {
  UPSTREAM_CHAT_URL: "https://up.example.test/api/chat",
  UPSTREAM_ORIGIN: "https://web.example.test",
  UPSTREAM_REFERER: "https://web.example.test/",
};
const png = (size = 8) =>
  new Blob([new Uint8Array(size)], { type: "image/png" });

/** Upstream that accepts every step; individual tests override one. */
function upstream(
  override: (url: string) => Response | undefined = () => undefined,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const forced = override(url);
    if (forced) return forced;
    if (url.endsWith("/api/uploads/presign")) {
      return Response.json({
        fileId: "f1",
        uploadUrl: "https://r2.test/put",
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url === "https://r2.test/put") return new Response(null);
    if (url.endsWith("/api/uploads/f1/complete"))
      return Response.json({ id: "f1" });
    throw new Error(`unexpected fetch ${url}`);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("uploadImage", () => {
  it("presigns, PUTs to storage with its headers, completes, returns the id", async () => {
    const fetch = upstream();
    expect(await uploadImage(png(), "a.png", "jwt", env)).toBe("f1");

    const [[presignUrl, presign], [putUrl, put], [completeUrl, complete]] =
      fetch.mock.calls as [
        [string, RequestInit],
        [string, RequestInit],
        [string, RequestInit],
      ];
    expect(String(presignUrl)).toBe(
      "https://up.example.test/api/uploads/presign",
    );
    expect(presign.headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(JSON.parse(String(presign.body))).toEqual({
      kind: "chat_image",
      mime: "image/png",
      size: 8,
      originalName: "a.png",
    });
    expect(putUrl).toBe("https://r2.test/put");
    // The signed URL carries its own auth; the session JWT must not leak there.
    expect(put).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "image/png" },
    });
    expect(String(completeUrl)).toBe(
      "https://up.example.test/api/uploads/f1/complete",
    );
    expect(complete.body).toBeUndefined();
  });

  it("rejects an unsupported type or an oversized image without calling upstream", async () => {
    const fetch = upstream();
    const svg = new Blob(["<svg/>"], { type: "image/svg+xml" });
    await expect(uploadImage(svg, "a", "jwt", env)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      uploadImage(png(4 * 1024 * 1024 + 1), "a", "jwt", env),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards upstream's wording when presign fails", async () => {
    upstream((u) =>
      u.endsWith("/presign")
        ? new Response("Too many uploads", { status: 429 })
        : undefined,
    );
    await expect(uploadImage(png(), "a", "jwt", env)).rejects.toMatchObject({
      status: 429,
      message: "Upload failed: upstream returned 429: Too many uploads",
    });
  });

  it("fails on a refused PUT and on a complete with no id", async () => {
    upstream((u) =>
      u === "https://r2.test/put"
        ? new Response("", { status: 403 })
        : undefined,
    );
    await expect(uploadImage(png(), "a", "jwt", env)).rejects.toMatchObject({
      status: 403,
    });

    vi.restoreAllMocks();
    upstream((u) => (u.endsWith("/complete") ? Response.json({}) : undefined));
    await expect(uploadImage(png(), "a", "jwt", env)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("502s when presign returns no upload URL", async () => {
    upstream((u) =>
      u.endsWith("/presign") ? Response.json({ fileId: "f1" }) : undefined,
    );
    await expect(uploadImage(png(), "a", "jwt", env)).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("toFileId", () => {
  it("decodes a base64 data URI and uploads it with its mime", async () => {
    const fetch = upstream();
    const id = await toFileId(
      `data:image/png;base64,${btoa("abc")}`,
      "jwt",
      env,
    );
    expect(id).toBe("f1");
    const body = JSON.parse(
      String((fetch.mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(body).toMatchObject({ mime: "image/png", size: 3 });
  });

  it("400s a data URI that is not base64, or not valid base64", async () => {
    upstream();
    await expect(
      toFileId("data:image/png,raw", "jwt", env),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      toFileId("data:image/png;base64,***", "jwt", env),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it("fetches an http(s) image and names the upload after its path", async () => {
    const fetch = upstream((u) =>
      u === "https://i.test/x/cat.png"
        ? new Response("png", { headers: { "content-type": "image/png" } })
        : undefined,
    );
    expect(await toFileId("https://i.test/x/cat.png", "jwt", env)).toBe("f1");
    const body = JSON.parse(
      String((fetch.mock.calls[1] as [string, RequestInit])[1].body),
    );
    expect(body.originalName).toBe("cat.png");
  });

  it("400s an image URL that fails or declares more than 4 MB", async () => {
    upstream((u) =>
      u === "https://i.test/404"
        ? new Response("", { status: 404 })
        : undefined,
    );
    await expect(
      toFileId("https://i.test/404", "jwt", env),
    ).rejects.toMatchObject({ status: 400 });

    vi.restoreAllMocks();
    upstream((u) =>
      u === "https://i.test/big"
        ? new Response("x", {
            headers: { "content-length": String(5 * 1024 * 1024) },
          })
        : undefined,
    );
    await expect(
      toFileId("https://i.test/big", "jwt", env),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("treats anything else as an existing fileId", async () => {
    const fetch = upstream();
    expect(await toFileId("01a1-file", "jwt", env)).toBe("01a1-file");
    expect(fetch).not.toHaveBeenCalled();
  });
});
