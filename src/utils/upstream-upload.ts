import { UPLOAD_TIMEOUT } from "../constants/timeouts";
import { invalidRequest, upstreamError } from "./errors";

// Upstream's `chat_image` limits, from the web client's bundled config.
const MAX_BYTES = 4 * 1024 * 1024;
const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// shortcut: the web client attaches at most 4 images per send; the server-side
// cap is unverified. Enforced here so a rejected send can't orphan uploads.
export const MAX_IMAGES = 4;

export interface UploadEnv {
  UPSTREAM_CHAT_URL: string;
  UPSTREAM_ORIGIN: string;
  UPSTREAM_REFERER: string;
}

/**
 * Upload an image the way the web client does — presign, PUT the bytes to the
 * signed storage URL, complete — and return the fileId that chat
 * `message.attachments` takes. Verified live end to end (model saw the image).
 */
export async function uploadImage(
  blob: Blob,
  name: string,
  token: string,
  env: UploadEnv,
): Promise<string> {
  const mime = blob.type.split(";")[0]!.trim().toLowerCase();
  if (!MIMES.includes(mime)) {
    throw invalidRequest(
      `Unsupported image type '${blob.type || "unknown"}': use JPEG, PNG, WebP or GIF.`,
    );
  }
  if (blob.size === 0 || blob.size > MAX_BYTES) {
    throw invalidRequest(
      `Image is ${blob.size} bytes; upstream accepts 1 byte to 4 MB.`,
    );
  }

  const presign = (await api(env, token, "uploads/presign", {
    kind: "chat_image",
    mime,
    size: blob.size,
    originalName: name || "image",
  })) as { fileId?: unknown; uploadUrl?: unknown; headers?: unknown };
  if (
    typeof presign.fileId !== "string" ||
    typeof presign.uploadUrl !== "string"
  ) {
    throw upstreamError(502, "Upload presign returned no upload URL.");
  }

  // Signed storage URL: its own headers (Content-Type) and no upstream auth.
  const put = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: (presign.headers as Record<string, string>) ?? {
      "content-type": mime,
    },
    body: blob,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
  });
  if (!put.ok) {
    throw upstreamError(
      put.status,
      `Image upload refused: storage returned ${put.status}.`,
    );
  }

  const done = (await api(
    env,
    token,
    `uploads/${encodeURIComponent(presign.fileId)}/complete`,
  )) as { id?: unknown };
  if (typeof done.id !== "string") {
    throw upstreamError(
      502,
      "Upload completed but upstream returned no file id.",
    );
  }
  return done.id;
}

async function api(
  env: UploadEnv,
  token: string,
  path: string,
  json?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(`/api/${path}`, env.UPSTREAM_CHAT_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: env.UPSTREAM_ORIGIN,
      referer: env.UPSTREAM_REFERER,
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim();
    throw upstreamError(
      res.status,
      `Upload failed: upstream returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : "."}`,
    );
  }
  return ((await res.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
}

/**
 * An OpenAI `image_url.url` → upstream fileId. A `data:` URI or http(s) URL
 * is uploaded; anything else is taken as a fileId from POST /v1/files.
 */
export async function toFileId(
  url: string,
  token: string,
  env: UploadEnv,
): Promise<string> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)(?:;[^;,=]+=[^;,]*)*;base64,(.*)$/s.exec(url);
    if (!m)
      throw invalidRequest(
        "Image data URIs must be base64 encoded.",
        "messages",
      );
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(m[2]!), (ch) => ch.charCodeAt(0));
    } catch {
      throw invalidRequest("Image data URI is not valid base64.", "messages");
    }
    return uploadImage(new Blob([bytes], { type: m[1] }), "image", token, env);
  }

  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    }).catch(() => null);
    if (!res?.ok) {
      throw invalidRequest(
        `Could not fetch image ${url} (${res?.status ?? "network error"}).`,
        "messages",
      );
    }
    // Refuse an oversized image before buffering it, when the size is declared.
    if (Number(res.headers.get("content-length")) > MAX_BYTES) {
      throw invalidRequest(
        `Image ${url} is over upstream's 4 MB limit.`,
        "messages",
      );
    }
    const name = new URL(url).pathname.split("/").pop() || "image";
    return uploadImage(await res.blob(), name, token, env);
  }

  return url;
}
