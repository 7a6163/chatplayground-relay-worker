import { Hono } from "hono";
import type { Env, Variables } from "../types/env";
import { invalidRequest } from "../utils/errors";
import { uploadImage } from "../utils/upstream-upload";

const files = new Hono<{ Bindings: Env; Variables: Variables }>();

// OpenAI Files API — used by SDKs to upload images for vision chats. The
// image goes through upstream's own upload flow, and the upstream fileId comes
// back as the file `id`, which chat accepts as `image_url.url`.
files.post("/v1/files", async (c) => {
  const contentType = c.req.header("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw invalidRequest(
      "Request must be multipart/form-data with a 'file' field.",
    );
  }

  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) {
    throw invalidRequest("Multipart body has no 'file' field.", "file");
  }

  const token = await c.get("sessionToken")();
  const id = await uploadImage(file, file.name, token, c.env);

  return c.json({
    id, // doubles as image_url.url for follow-up vision chats
    object: "file",
    bytes: file.size,
    created_at: Math.floor(Date.now() / 1000),
    filename: file.name, // never empty: an empty filename parses as a string field
    purpose: "vision",
    status: "processed",
    status_details: null,
  });
});

export default files;
