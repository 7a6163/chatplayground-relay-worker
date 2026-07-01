# chatplayground-relay-worker

> OpenAI-compatible Cloudflare Worker that relays to [chatplayground.ai](https://web.chatplayground.ai/).
> BYOK, stateless, multi-model. Drop-in `base_url` for OpenAI SDKs, Chatbox, LangChain, etc.

## What it does

Wraps chatplayground.ai's internal chat endpoint as a standard OpenAI
`/v1/chat/completions` API, so any OpenAI-compatible client can use
chatplayground's chat models with your existing chatplayground account.

```
OpenAI SDK ──► Cloudflare Worker ──► chatplayground.ai
              (this repo)            (your account)
```

No keys stored, no chat history persisted, no database. Just a translator.

## Status: experimental

chatplayground.ai does not publish a public API. This worker reverse-engineers
their internal endpoints. The following will break it (degrade gracefully
where possible):

- chatplayground changes endpoint paths or request shape
- chatplayground tightens authentication on their internal endpoint
- chatplayground changes the `/api/models` shape in a way that breaks discovery
  (falls back to a small SEED list on failure)

## Authentication: bring your own Clerk user ID

You provide your chatplayground Clerk user ID (looks like `user_xxxxxxxxxxxxx`)
as the OpenAI-style Bearer token. The worker forwards it to upstream as
`X-Clerk-User-Id`.

**How to find your Clerk user ID:**

1. Open <https://web.chatplayground.ai/> and sign in
2. Open DevTools → Network tab
3. Send any message in the UI
4. Find the request to `/api/chat/azure`
5. Copy the value of the `X-Clerk-User-Id` request header

> ⚠️ **Treat your Clerk user ID like an API key.**
> It grants access to your chatplayground account quota.
> Don't share it. Don't post your worker URL publicly without thinking.

### Optional: gateway mode (custom API key, hidden Clerk ID)

Passthrough mode hands your Clerk ID to every client. If you'd rather keep the
Clerk ID server-side and give callers a custom key you can rotate, set two
secrets:

```bash
wrangler secret put CLERK_USER_ID    # your real user_... identity
wrangler secret put RELAY_API_KEY    # a key you invent, e.g. sk-relay-xxxxx
```

Once `RELAY_API_KEY` is set, callers authenticate with **that** key
(`Authorization: Bearer sk-relay-xxxxx`) and the worker uses the stored
`CLERK_USER_ID` upstream — the real identity is never exposed. Unset the secret
to fall back to passthrough. (Secrets, not `wrangler.jsonc` vars — vars are
plaintext.)

## Features

| Endpoint | Notes |
|---|---|
| `POST /v1/chat/completions` | Stream + non-stream; multimodal (`image_url` content parts) |
| `GET /v1/models` | Dynamic discovery from chatplayground's `/api/models`, KV + memory cached |
| `POST /v1/files` | Image upload proxy → returns a URL usable as `image_url.url` |

| Not supported | Why |
|---|---|
| Tool / function calling | No upstream chat endpoint exposes tool use |
| `/v1/images/generations` | Upstream image-gen models live on a different endpoint |
| `/v1/embeddings` | Upstream doesn't expose embeddings |
| `/v1/audio/*` | Upstream doesn't expose audio |

### Chat models (auto-discovered)

chatplayground serves chat models from **three upstream endpoints**
(`azure` / `perplexity` / `lmsys`), routed by model `botId`. The relay mirrors
that routing automatically, so a single OpenAI `model` field reaches the right
one. It exposes **every chat-group model** in the feed — including models
chatplayground marks `active:false` (hidden in their UI but still callable
upstream, e.g. perplexity `sonar-pro`).

Some commonly-available ids (call `GET /v1/models` for the live set):

| Model id (use this in `model` field) | Provider | Endpoint | Vision |
|---|---|---|---|
| `gpt-5.5` | openai | azure | ✅ |
| `gpt-5.4` | openai | azure | ✅ |
| `gemini-3-flash` | google | azure | ✅ |
| `claude-haiku-4-5` | anthropic | azure | ✅ |
| `deepseek-v4-pro` | deepseek | azure | — |
| `kimi-k2.6` | moonshot | azure | — |
| `perplexity-sonar-pro` | perplexity | perplexity | — |
| `llama-4-scout` | meta | lmsys | ✅ |

> Perplexity models return a structured citation list at the end of the
> stream. The relay strips that raw payload and re-emits the URLs as a
> Markdown `**Sources**` block; on the non-streaming path it also rewrites
> inline `[N]` markers as Markdown links so they render as clickable in
> OpenAI-compatible chat clients.

## Quick start

### Local development

```bash
git clone https://github.com/<your-user>/chatplayground-relay-worker
cd chatplayground-relay-worker
npm install
npm run dev
# → http://localhost:8787
```

### Deploy to Cloudflare

```bash
npm run deploy
# → https://chatplayground-relay.<your-account>.workers.dev
```

### Optional: KV-backed model cache

Without KV, model discovery falls back to a 5-minute per-isolate memory cache
plus a hardcoded SEED fallback list. That's fine for personal use. For shared
deployments you can add KV:

```bash
npx wrangler kv namespace create MODEL_CACHE
# Then uncomment the kv_namespaces block in wrangler.jsonc and paste the printed ID.
```

## Usage

### curl

```bash
export WORKER=https://chatplayground-relay.<acct>.workers.dev
export KEY=user_YOUR_CLERK_ID

# List models
curl -s $WORKER/v1/models -H "Authorization: Bearer $KEY" | jq

# Non-streaming chat
curl -s $WORKER/v1/chat/completions \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"say hi"}]}' | jq

# Streaming
curl -N $WORKER/v1/chat/completions \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gemini-3-flash","messages":[{"role":"user","content":"count to 5"}],"stream":true}'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://chatplayground-relay.<acct>.workers.dev/v1",
    api_key="user_YOUR_CLERK_ID",
)

# Text
resp = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "What is use-after-free?"}],
)
print(resp.choices[0].message.content)

# Streaming
for chunk in client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "Count to 5"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="", flush=True)

# Vision — upload via /v1/files, then reference
file = client.files.create(file=open("photo.jpg", "rb"), purpose="vision")
resp = client.chat.completions.create(
    model="gemini-3-flash",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this image?"},
            {"type": "image_url", "image_url": {"url": file.id}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

### Chatbox / desktop clients

Add a custom OpenAI-compatible provider:

- **API host / base URL**: `https://chatplayground-relay.<acct>.workers.dev/v1`
- **API key**: your `user_xxxxxxxx` Clerk ID
- **Model**: any id from `GET /v1/models`

### Continuing a chatplayground-side conversation

Every API call defaults to a fresh chatplayground chat with `noSave: true` —
nothing shows up in your chatplayground.ai dashboard, and each request starts
a new conversation on the upstream side. The conversation still works because
OpenAI clients re-send the full `messages[]` array every turn.

Two opt-in extension fields let you change that:

| If you want | Add to request body |
|---|---|
| Save to chatplayground history | `"metadata": {"save": true}` |
| Continue a specific chatplayground chat | `"user": "<chatId>"` (CUID from a prior chatplayground session) |

Standard OpenAI SDKs don't surface these but you can hand-craft the request.

## Architecture

```
caller (OpenAI SDK)
  │  POST /v1/chat/completions
  │  Authorization: Bearer user_xxxxx
  ▼
Cloudflare Worker (Hono)
  ├── middleware/auth          → extract Clerk user_id from Bearer / X-Clerk-User-Id
  ├── middleware/error-handler → wrap thrown errors in OpenAI envelope
  ├── routes/chat              → translate body, fetch upstream, stream back
  ├── routes/models            → live discovery + 3-layer cache
  └── routes/files             → forward multipart to temp-file-host
                │
                │  POST app.chatplayground.ai/api/chat/{azure|perplexity|lmsys}
                │       (endpoint chosen per model botId)
                │  Content-Type: text/plain;charset=UTF-8
                │  X-Clerk-User-Id: <forwarded>
                ▼
       chatplayground upstream
                │  text/plain stream + trailing "CHAT_ID:<cuid>" sentinel
                ▼
       streamUpstreamAsOpenAI → OpenAI chat.completion.chunk SSE
```

### Model discovery

`/v1/models` doesn't hardcode a list. Each request goes through:

1. **In-isolate memory cache** (5 min TTL) — hits if isolate is warm
2. **KV cache** (1 h TTL) — hits across isolates if `MODEL_CACHE` binding is configured
3. **Live discovery** — `GET app.chatplayground.ai/api/models` (public JSON,
   no auth), validate each entry (`{botId, modelName, provider, group,
   endpoint, active}`), keep `group:"chat"`. The `active` flag is **not**
   filtered on — it controls UI visibility only; inactive models are still
   callable upstream. Each entry's `endpoint` field decides which of the three
   `/api/chat/*` upstreams serves it.
4. **SEED fallback** — small hardcoded list, used if discovery fails

## Project layout

```
src/
├── index.ts                  Hono app + CORS + auth + route mounting
├── constants/
│   ├── models.ts             SEED fallback registry
│   └── timeouts.ts           CHAT / UPLOAD / DISCOVERY fetch timeouts
├── middleware/
│   ├── auth.ts               Bearer / X-Clerk-User-Id → ctx.clerkUserId
│   └── error-handler.ts      → OpenAI error envelope
├── routes/
│   ├── chat.ts               POST /v1/chat/completions
│   ├── models.ts             GET  /v1/models
│   └── files.ts              POST /v1/files
├── types/
│   ├── env.ts                Worker bindings + Hono Variables
│   ├── openai.ts             OpenAI request/response/chunk shapes
│   └── upstream.ts           chatplayground request body shape
└── utils/
    ├── errors.ts             OpenAIHTTPError class + factory helpers
    ├── model-id.ts           findModel(input, registry)
    ├── model-discovery.ts    /api/models fetch + validate + cache layers
    ├── upstream-request.ts   OpenAI → chatplayground body translator
    └── upstream-stream.ts    CHAT_ID sentinel strip + OpenAI SSE wrap
```

## Configuration

All defaults are sensible; you only need to change these to point at a
different upstream instance.

| Env var | Default | Purpose |
|---|---|---|
| `UPSTREAM_CHAT_URL` | `https://app.chatplayground.ai/api/chat/azure` | Azure chat endpoint; the `perplexity` / `lmsys` sibling URLs are derived from it |
| `UPSTREAM_ORIGIN` | `https://web.chatplayground.ai` | Forwarded as `Origin` |
| `UPSTREAM_REFERER` | `https://web.chatplayground.ai/` | Forwarded as `Referer` |
| `UPSTREAM_UPLOAD_URL` | `https://temp-file-host.chatplayground.ai/upload` | File upload endpoint |

Optional KV bindings:

| Binding | Purpose |
|---|---|
| `MODEL_CACHE` | Cross-isolate model registry cache (1 h TTL) |

## Caveats

1. **No tool / function calling.** None of the upstream chat endpoints
   (`azure` / `perplexity` / `lmsys`) support it — live-tested: injected
   OpenAI `tools` are ignored and answered as prose, and a forced
   `tool_choice` returns a plain-text error, never a structured `tool_calls`
   reply. The relay also never forwards `tools` / `tool_choice` upstream.
2. **No real usage counts.** chatplayground doesn't return token usage, so
   the `usage` field is estimated (chars ÷ 4). Don't bill on it.
3. **Brittle to upstream changes.** Any change to `/api/models` shape, endpoint
   path, or request shape may break the worker. Open an issue / PR.
4. **`/v1/files` is essentially anonymous.** chatplayground's upload
   endpoint accepts any caller (no auth), and our Bearer regex is a speed
   bump, not a gate. If you deploy publicly and care about your worker's
   request quota, add a size cap or remove the route.
5. **Keep your Clerk user ID private.** It grants access to your
   chatplayground account quota; treat it like an API key.

## License

[MIT](./LICENSE).

## Disclaimer

This is an independent reverse-engineering project. It is not affiliated with,
sponsored by, or endorsed by ChatPlayground AI. Use at your own risk and
respect chatplayground.ai's terms of service. The author of this repository
assumes no responsibility for misuse.
