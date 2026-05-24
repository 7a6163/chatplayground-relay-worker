import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types/env";
import { unauthorized } from "../utils/errors";

const CLERK_USER_ID_RE = /^user_[a-zA-Z0-9]+$/;

export const auth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const fromBearer = c.req
    .header("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const fromHeader = c.req.header("x-clerk-user-id")?.trim();
  const id = fromBearer || fromHeader || "";

  if (!CLERK_USER_ID_RE.test(id)) {
    throw unauthorized(
      "Missing or malformed credentials. Send your chatplayground Clerk user ID (user_...) as `Authorization: Bearer <id>` or `X-Clerk-User-Id: <id>`.",
    );
  }

  c.set("clerkUserId", id);
  await next();
});
