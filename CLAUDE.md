# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker (Hono) that turns chatplayground.ai's internal, reverse-engineered chat API into an OpenAI-compatible API: `POST /v1/chat/completions`, `GET /v1/models` and `POST /v1/files`. It is stateless with no database. KV (`MODEL_CACHE`) is the only storage.

## Commands

```bash
npm run dev            # wrangler dev → http://localhost:8787
npm test               # vitest run
npx vitest run tests/chat.test.ts          # single file
npx vitest run tests/chat.test.ts -t "name" # single test by name
npm run typecheck      # tsc --noEmit
npm run check          # oxfmt --check + oxlint (format: `npm run format`)
npm run test:coverage
npm run deploy         # wrangler deploy --minify
```

CI (`.github/workflows/ci.yml`) runs format:check, lint, typecheck, test:coverage and `npm audit --omit=dev`. `release.yml` creates GitHub release `v<package.json version>` whenever a version bump lands on main. Releasing means bumping `package.json`; there is no tag to create by hand.

## Architecture

Request flow: `index.ts` (CORS, `onError(errorHandler)`, `auth` on `/v1/*`) → route → upstream `fetch`.

- **Auth has two modes** (`middleware/auth.ts`):
  - Passthrough (default): the caller's Bearer must be shaped like a JWT. It is a Clerk session token, valid for 60s, and is forwarded upstream unchanged.
  - Gateway: when `RELAY_API_KEY` is set, the caller presents that key instead, and the worker mints its own token through `utils/clerk-token.ts`.

  In both modes the middleware sets `c.get("sessionToken")` to a **thunk**, not a string. Only routes that call upstream invoke it, so `/v1/models` never pays for, or fails on, Clerk round-trips. Keep it lazy.
- **Gateway credential lifecycle** (`utils/clerk-token.ts`): the Clerk `__client` cookie is resolved from KV `clerk:client_cookie` first, then from the `CLERK_CLIENT_COOKIE` secret. If both fail with a 401/403 and `CLERK_EMAIL` + `CLERK_PASSWORD` are set, the worker signs in for itself (on auth failure only, never on a 5xx). The session id is looked up through `GET /v1/client`, not configured. Rotated cookies from `Set-Cookie` are written back to KV. The token is cached per isolate and refreshed 15s before expiry. The README sections "Gateway mode" and "How the cookie stays alive" explain the reasons behind this.
- **Model discovery** (`utils/model-discovery.ts`): memory cache (5 min), then KV (1 h), then live `GET /api/models`, a public feed fetched without credentials. **There is deliberately no hardcoded fallback list.** A discovery failure returns 503 `model_discovery_failed`. Do not add a fallback list. Two filtering rules:
  - The cached registry is the full list. `premiumOnly` is filtered at read time in `routes/models.ts`, gated on `PREMIUM_MODELS === "true"`.
  - The feed's `active` and `tier` flags gate nothing; do not filter on them.
- **One upstream route**: every model goes to `POST UPSTREAM_CHAT_URL` (`web.chatplayground.ai/api/chat`), keyed by the feed's `slug` (`modelSlug`). `/api/models` is derived from it as a sibling.
- **Translation**: `utils/upstream-request.ts` builds `{modelSlug, submissionId, message:{text}, conversationId?, noSave}` (`noSave: true` by default, verified to keep calls out of history). The opt-ins are `metadata.save` and `user` = conversationId. `tools` and `tool_choice` are never forwarded. Upstream takes one prompt per call, so a multi-message history is folded into one role-labelled transcript (`collapseHistory`). Image parts become `message.attachments` fileIds: `utils/upstream-upload.ts` uploads data URIs and http(s) URLs via `/api/uploads/presign` → storage PUT → `/complete`; any other url is taken as a fileId from `/v1/files`.
  - Upstream replies with a Vercel AI SDK UI-message SSE stream (`text-delta`, `reasoning-delta`, `source-url`, `error`, `finish` with `messageMetadata.usage`).
  - `utils/upstream-stream.ts` parses it (`readEvents`) and re-emits text as OpenAI SSE (`streamUpstreamAsOpenAI`) or collects it (`collectUpstream`). Reasoning is dropped; `source-url`s become a Sources block, and the non-stream path also rewrites `[N]` markers into links.
  - Non-stream `usage` is upstream's counts (reasoning inside `completion_tokens`), chars÷4 only as a fallback.
  - `/v1/files` uses the same upload flow and returns the fileId as the file `id`.
- **Errors**: throw `OpenAIHTTPError` or its helpers (`utils/errors.ts`). `errorHandler` wraps them in the OpenAI error envelope. Upstream non-2xx responses are passed through with upstream's own text (`upstream_<status>`). 429s are not retried.

## Testing conventions

- Vitest runs in the plain Node environment, not workerd. Tests drive the real Hono app or route through `app.request()` with a stub `env` object. `globalThis.fetch` (via `vi.spyOn`) is the only thing mocked. `tests/chat.test.ts` shows the pattern.
- Module-level caches must be reset in `beforeEach`: `resetModelCache()` and `resetSessionTokenCache()`.
- Node and workerd differ in `Headers` (for example `getSetCookie`). Some tests exist specifically to cover the workerd-shaped behavior, so keep them.
- Coverage excludes `src/types/**` and `src/constants/models.ts`.

## Conventions

- Shortcuts are marked with `ponytail:` / `shortcut:` comments that state the limit.
- Comments explain *why*, often including facts verified against the live upstream (for example, "minting does not rotate the cookie"). Keep these facts; don't re-derive them from flag names.
- Secrets (`RELAY_API_KEY`, `CLERK_*`) are set with `wrangler secret put` and never as `wrangler.jsonc` vars.
