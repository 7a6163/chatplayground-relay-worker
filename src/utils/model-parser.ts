import type { ModelEntry } from "../constants/models";

// chatplayground's Vite bundle stores models as an inline array of object
// literals. Field order varies after minification, so we don't anchor on
// order — instead, find each entry by its `{botId:"..."` prefix and then
// regex each field independently within a small window.
//
// Confirmed entry shape (from /assets/index-D-GKfsag.js):
//   {botId:"X",modelName:"Y",bot:{name:"Z",avatar:ref},active:!0,
//    provider:"google",group:"chat",index:6,supportImage:!0}
// (any order; booleans minified to !0 / !1)

const ENTRY_START_RE = /\{botId:"([^"]+)"/g;
const WINDOW_CHARS = 400;

function strField(src: string, name: string): string | null {
  const m = new RegExp(`${name}:"([^"]+)"`).exec(src);
  return m?.[1] ?? null;
}

function boolField(src: string, name: string): boolean {
  const m = new RegExp(`${name}:(!\\d|true|false)`).exec(src);
  if (!m) return false;
  return m[1] === "true" || m[1] === "!0";
}

export function parseModels(bundleSource: string): ModelEntry[] {
  const out: ModelEntry[] = [];
  ENTRY_START_RE.lastIndex = 0;

  let match: RegExpExecArray | null = ENTRY_START_RE.exec(bundleSource);
  while (match !== null) {
    const botId = match[1];
    if (botId) {
      const window = bundleSource.slice(
        match.index,
        match.index + WINDOW_CHARS,
      );
      const modelName = strField(window, "modelName");
      const provider = strField(window, "provider");
      const group = strField(window, "group");
      const active = boolField(window, "active");

      // Only expose active chat models. Image/audio groups are filtered
      // because they don't go through /api/chat/azure.
      if (modelName && provider && group === "chat" && active) {
        const providerLc = provider.toLowerCase();
        out.push({
          id: botId,
          upstreamModel: `${providerLc}/${modelName}`,
          upstreamBotId: botId,
          provider: providerLc,
        });
      }
    }
    match = ENTRY_START_RE.exec(bundleSource);
  }
  return out;
}
