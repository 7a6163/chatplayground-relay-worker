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
  (`/v1/models` and chat then return 503 until it recovers)

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
| `GET /v1/models` | Dynamic discovery from chatplayground's `/api/models`, KV + memory cached; `premiumOnly` models hidden unless `PREMIUM_MODELS="true"` |
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
one. Models chatplayground marks `active:false` are still exposed — that flag
is UI visibility only, and inactive models remain callable upstream.

Models the feed marks `premiumOnly` are **hidden from `GET /v1/models` by
default**, because upstream returns 403 for them without a premium plan; set
`PREMIUM_MODELS="true"` to list them anyway. Everything else is shown,
including the three models flagged `lifetimeOnly` — see the caveats for what
that flag is and isn't known to do. Hidden models stay callable either way:
the filter only changes what the relay advertises, and upstream remains the
thing that enforces access.

Snapshot of the feed (call `GET /v1/models` for the live set):

| Model id (use this in `model` field) | Provider | Endpoint | Vision | Access |
|---|---|---|---|---|
| `gpt-5.6-terra` | openai | azure | ✅ | — |
| `gpt-5.6-luna` | openai | azure | ✅ | — |
| `mistral-large-3` | mistral | azure | ✅ | — |
| `deepseek-v4-pro` | deepseek | azure | — | — |
| `deepseek-v4-flash` | deepseek | azure | — | — |
| `deepseek-r1` | deepseek | azure | — | — |
| `llama-4-scout` | meta | lmsys | ✅ | — |
| `llama-4-maverick` | meta | lmsys | ✅ | — |
| `grok-4.5` | xai | lmsys | ✅ | — |
| `qwen3.7-plus` | qwen | lmsys | ✅ | — |
| `minimax-m3` | minimax | lmsys | ✅ | — |
| `command-a` | cohere | lmsys | ✅ | — |
| `perplexity-sonar` | perplexity | perplexity | ✅ | — |
| `claude-sonnet-4-6` | anthropic | azure | ✅ | lifetime |
| `gemini-3.5-flash-lite` | google | azure | ✅ | lifetime |
| `kimi-k2.6` | kimi | azure | ✅ | lifetime |
| `claude-opus-5` | anthropic | azure | ✅ | premium |
| `claude-sonnet-5` | anthropic | azure | ✅ | premium |
| `gpt-5.6-sol` | openai | azure | ✅ | premium |
| `gemini-3.1-pro` | google | azure | ✅ | premium |
| `grok-4.6` | xai | lmsys | ✅ | premium |
| `perplexity-sonar-pro` | perplexity | perplexity | ✅ | premium |

`lifetime` = the feed's `lifetimeOnly` flag; those need a lifetime plan but
are **not** `premiumOnly`, so they are listed by default. Truncated — the feed
carried 33 chat models when this was written, 12 of them `premiumOnly`.

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

Without KV, model discovery has only a 5-minute per-isolate memory cache, so
every cold isolate refetches the feed and an upstream blip surfaces as a 503.
That's fine for personal use. For shared deployments you can add KV:

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
     -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"say hi"}]}' | jq

# Streaming
curl -N $WORKER/v1/chat/completions \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"count to 5"}],"stream":true}'
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
    model="gpt-5.6-luna",
    messages=[{"role": "user", "content": "What is use-after-free?"}],
)
print(resp.choices[0].message.content)

# Streaming
for chunk in client.chat.completions.create(
    model="gpt-5.6-luna",
    messages=[{"role": "user", "content": "Count to 5"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="", flush=True)

# Vision — upload via /v1/files, then reference
file = client.files.create(file=open("photo.jpg", "rb"), purpose="vision")
resp = client.chat.completions.create(
    model="llama-4-scout",
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
   endpoint, active, premiumOnly}`), keep `group:"chat"`. The `active` flag is
   **not** filtered on — it controls UI visibility only; inactive models are
   still callable upstream. Each entry's `endpoint` field decides which of the
   three `/api/chat/*` upstreams serves it.
If all three miss, the request fails with **503** `model_discovery_failed`.
There is deliberately no hardcoded fallback list: it would be a copy of data
that lives upstream, so it rots unnoticed and only gets used on the day
discovery is already broken — and serving it turned "discovery is down" into a
404 `model_not_found`, which tells callers a model doesn't exist when it does.

`/api/models` is fetched **without** the Clerk id: it is a public catalogue and
returns the same bytes with or without one. Upstream ships the raw flags and
lets its own frontend filter, so there is no per-account entitlement to query —
which is why `PREMIUM_MODELS` is something you set rather than something the
relay works out. Access is only observable by making a chat call and reading
the 403, and a model listing shouldn't spend credits to find out.

The registry cached at every layer is the **full** list. `premiumOnly` is
filtered at read time in the `/v1/models` handler, so flipping
`PREMIUM_MODELS` takes effect immediately rather than waiting out the 1 h KV
TTL. Note the gate is `premiumOnly`, not the feed's `tier` field:
`gemini-3.7-flash` is `tier:"basic"` and still 403s without premium.

## Project layout

```
src/
├── index.ts                  Hono app + CORS + auth + route mounting
├── constants/
│   ├── models.ts             ModelEntry shape (no hardcoded list)
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
| `PREMIUM_MODELS` | unset | `"true"` lists `premiumOnly` models in `GET /v1/models`. Leave unset unless the account has premium — upstream 403s them otherwise. Any other value counts as off |

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
3. **Premium models 403 on a non-premium account.** The feed marks 12 of its
   33 chat models `premiumOnly`; upstream rejects them unless the account has
   premium. They're hidden from `GET /v1/models` by default but stay callable,
   so a hardcoded id returns HTTP 403 `upstream_403`. The gate is `premiumOnly`,
   not the feed's `tier` field — `gemini-3.7-flash` is `tier:"basic"` and still
   403s — verified on all three models where the two fields disagree.
4. **Upstream rate-limits bursts.** A run of back-to-back chat calls starts
   returning `429 You're sending prompts too quickly`, with no `Retry-After`
   header to pace against. The relay passes 429 through unchanged so the
   client's own rate-limit backoff handles it.
5. **`lifetimeOnly` is an unresolved flag.** Three models carry it
   (`claude-sonnet-4-6`, `gemini-3.5-flash-lite`, `kimi-k2.6`). Only one was
   ever tested, on one paid account, and it worked — which cannot distinguish
   a real entitlement gate from a UI badge, the way `active` is one. It is
   also not established that the flag refers to the same product as any given
   "lifetime" plan. The relay does not read it: all three are
   `premiumOnly:false`, so they are listed regardless of what it means.
6. **Brittle to upstream changes.** Any change to `/api/models` shape, endpoint
   path, or request shape may break the worker. Open an issue / PR.
7. **`/v1/files` is essentially anonymous.** chatplayground's upload
   endpoint accepts any caller (no auth), and our Bearer regex is a speed
   bump, not a gate. If you deploy publicly and care about your worker's
   request quota, add a size cap or remove the route.
8. **Keep your Clerk user ID private.** It grants access to your
   chatplayground account quota; treat it like an API key.

## License

[MIT](./LICENSE).

## Disclaimer

This is an independent reverse-engineering project. It is not affiliated with,
sponsored by, or endorsed by ChatPlayground AI. Use at your own risk and
respect chatplayground.ai's terms of service. The author of this repository
assumes no responsibility for misuse.
