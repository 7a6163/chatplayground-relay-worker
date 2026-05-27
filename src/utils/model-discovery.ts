import { SEED_MODELS, type ModelEntry } from "../constants/models";
import { DISCOVERY_TIMEOUT } from "../constants/timeouts";
import { parseModels } from "./model-parser";

const CACHE_KEY = "models:v2"; // v2: ModelEntry gained `modelName`
const KV_TTL_S = 60 * 60; // 1 hour — bundle hash rotates rarely
const MEM_TTL_MS = 5 * 60 * 1000; // 5 min in-isolate cache
const BUNDLE_RE = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/;

// Per-isolate memory cache. Survives across requests on a warm isolate
// and saves a KV roundtrip. Safe because the registry is shared truth.
let memCache: { at: number; data: ModelEntry[] } | null = null;

export interface DiscoveryEnv {
  UPSTREAM_HOMEPAGE: string;
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
    const fresh = await discover(env.UPSTREAM_HOMEPAGE);
    if (fresh.length === 0) throw new Error("parsed 0 models from bundle");
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

async function discover(homepageUrl: string): Promise<ModelEntry[]> {
  const html = await fetchText(homepageUrl);
  const m = BUNDLE_RE.exec(html);
  if (!m?.[1]) throw new Error("bundle URL not found in homepage HTML");

  const bundleUrl = new URL(`/assets/${m[1]}`, homepageUrl).toString();
  const js = await fetchText(bundleUrl);

  return parseModels(js);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (chatplayground-relay; +https://github.com/)",
      accept: "*/*",
    },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT),
  });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}
