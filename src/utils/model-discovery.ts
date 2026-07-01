import { toEndpoint } from "../constants/endpoints";
import { SEED_MODELS, type ModelEntry } from "../constants/models";
import { DISCOVERY_TIMEOUT } from "../constants/timeouts";

const CACHE_KEY = "models:v3"; // v3: switched to /api/models JSON; gained `endpoint`
const KV_TTL_S = 60 * 60; // 1 hour
const MEM_TTL_MS = 5 * 60 * 1000; // 5 min in-isolate cache

// Per-isolate memory cache. Survives across requests on a warm isolate
// and saves a KV roundtrip. Safe because the registry is shared truth.
let memCache: { at: number; data: ModelEntry[] } | null = null;

export interface DiscoveryEnv {
  UPSTREAM_CHAT_URL: string;
  MODEL_CACHE?: KVNamespace;
}

export async function getModels(env: DiscoveryEnv): Promise<ModelEntry[]> {
  if (memCache && Date.now() - memCache.at < MEM_TTL_MS) {
    return memCache.data;
  }

  if (env.MODEL_CACHE) {
    const cached = await env.MODEL_CACHE.get<ModelEntry[]>(CACHE_KEY, "json");
    if (cached && cached.length > 0) {
      memCache = { at: Date.now(), data: cached };
      return cached;
    }
  }

  try {
    const fresh = await discover(env.UPSTREAM_CHAT_URL);
    if (fresh.length === 0) throw new Error("no chat models in /api/models feed");
    if (env.MODEL_CACHE) {
      await env.MODEL_CACHE.put(CACHE_KEY, JSON.stringify(fresh), {
        expirationTtl: KV_TTL_S,
      });
    }
    memCache = { at: Date.now(), data: fresh };
    return fresh;
  } catch (err) {
    console.error("Model discovery failed; using SEED fallback.", err);
    return SEED_MODELS;
  }
}

// One entry in chatplayground's /api/models feed. Only the fields we consume.
interface ApiModel {
  botId: string;
  modelName: string;
  provider: string;
  group: string;
  endpoint: string;
}

async function discover(chatUrl: string): Promise<ModelEntry[]> {
  // /api/chat/azure → /api/models (sibling under /api/)
  const url = new URL("../models", chatUrl);
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT),
  });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);

  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new Error("models feed is not an array");

  const out: ModelEntry[] = [];
  for (const e of raw) {
    if (!isApiModel(e) || e.group !== "chat") continue;
    // Include inactive models too — `active` is UI visibility only; inactive
    // models (e.g. perplexity sonar-pro) are still callable upstream.
    const provider = e.provider.toLowerCase();
    out.push({
      id: e.botId,
      modelName: e.modelName,
      upstreamModel: `${provider}/${e.modelName}`,
      upstreamBotId: e.botId,
      provider,
      endpoint: toEndpoint(e.endpoint),
    });
  }
  return out;
}

function isApiModel(v: unknown): v is ApiModel {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.botId === "string" &&
    typeof o.modelName === "string" &&
    typeof o.provider === "string" &&
    typeof o.group === "string" &&
    typeof o.endpoint === "string"
  );
}
