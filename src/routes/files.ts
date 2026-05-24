import { Hono } from "hono";
import { UPLOAD_TIMEOUT } from "../constants/timeouts";
import type { Env, Variables } from "../types/env";
import { invalidRequest, upstreamError } from "../utils/errors";

const files = new Hono<{ Bindings: Env; Variables: Variables }>();

// OpenAI Files API — used by SDKs to upload images for vision chats.
// We forward the raw multipart body to chatplayground's temp-file-host
// (no upstream auth needed) and surface the resulting URL as the file `id`,
// so callers can paste it directly into `image_url.url` later.
//
// We don't parse the multipart ourselves because workers-types narrows
// FormData entries to `string | null`, making per-field access awkward.
// Forwarding the raw body is also more efficient (no buffering).
files.post("/v1/files", async (c) => {
  const contentType = c.req.header("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw invalidRequest(
      "Request must be multipart/form-data with a 'file' field.",
    );
  }

  const reqBody = c.req.raw.body;
  if (!reqBody) {
    throw invalidRequest("Request body is empty.");
  }

  const contentLengthHeader = c.req.header("content-length");
  const bytes = contentLengthHeader ? Number(contentLengthHeader) : 0;

  const res = await fetch(c.env.UPSTREAM_UPLOAD_URL, {
    method: "POST",
    headers: {
      "content-type": contentType,
      origin: c.env.UPSTREAM_ORIGIN,
      referer: c.env.UPSTREAM_REFERER,
      accept: "*/*",
    },
    body: reqBody,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
  });

  if (!res.ok) {
    throw upstreamError(
      res.status,
      `Upload failed: upstream returned ${res.status}.`,
    );
  }

  const body = (await res.json().catch(() => null)) as
    | { url?: string }
    | null;
  if (!body?.url) {
    throw upstreamError(
      502,
      "Upload succeeded but upstream did not return a URL.",
    );
  }

  // Best-effort OpenAI Files shape. We don't have filename/size from the
  // raw passthrough; SDKs that need them can read the URL from `id`.
  return c.json({
    id: body.url, // doubles as image_url.url for follow-up vision chats
    object: "file",
    bytes: Number.isFinite(bytes) ? bytes : 0,
    created_at: Math.floor(Date.now() / 1000),
    filename: "upload",
    purpose: "vision",
    status: "processed",
    status_details: null,
  });
});

export default files;
