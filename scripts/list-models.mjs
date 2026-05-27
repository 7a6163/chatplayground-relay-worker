#!/usr/bin/env node
// Replicates the worker's live model discovery (utils/model-discovery.ts +
// model-parser.ts) against the public chatplayground bundle — no auth needed.
// Prints the active chat-model registry the relay would serve from /v1/models.
//
// Run:  node scripts/list-models.mjs [search-term]
// e.g.  node scripts/list-models.mjs sonar

const HOMEPAGE = process.env.UPSTREAM_HOMEPAGE ?? "https://web.chatplayground.ai/";
const TERM = process.argv[2] ?? null;

const TRUE_MINIFIED = "!0"; // built without a literal ! to dodge shell history expansion
const FALSE_MINIFIED = "!1";

const html = await (await fetch(HOMEPAGE)).text();
const bundleMatch = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
if (!bundleMatch) {
  console.error("bundle URL not found in homepage HTML");
  process.exit(1);
}
const bundleName = bundleMatch[1];
const js = await (await fetch(new URL(`/assets/${bundleName}`, HOMEPAGE))).text();
console.log(`bundle: ${bundleName}  (${js.length} bytes)`);

function strField(src, name) {
  const m = new RegExp(`${name}:"([^"]+)"`).exec(src);
  return m ? m[1] : null;
}
function boolField(src, name) {
  const m = new RegExp(`${name}:(${TRUE_MINIFIED}|${FALSE_MINIFIED}|true|false)`).exec(src);
  if (!m) return false;
  return m[1] === "true" || m[1] === TRUE_MINIFIED;
}

const ENTRY_START_RE = /\{botId:"([^"]+)"/g;
const rows = [];
let match;
while ((match = ENTRY_START_RE.exec(js))) {
  const window = js.slice(match.index, match.index + 400);
  rows.push({
    botId: match[1],
    modelName: strField(window, "modelName"),
    provider: strField(window, "provider"),
    group: strField(window, "group"),
    active: boolField(window, "active"),
  });
}

const chat = rows.filter((r) => r.group === "chat" && r.active);
console.log(`\nactive chat models the relay serves (${chat.length}):`);
for (const r of chat) {
  console.log(`  ${r.botId}  ->  ${(r.provider || "?").toLowerCase()}/${r.modelName}`);
}

console.log(`\nall ${rows.length} bundle entries (incl. inactive / non-chat):`);
for (const r of rows) {
  console.log(`  ${r.active ? "on " : "off"} [${r.group ?? "?"}] ${r.botId} (${r.provider ?? "?"}/${r.modelName ?? "?"})`);
}

if (TERM) {
  const re = new RegExp(TERM, "i");
  const hits = rows.filter(
    (r) => re.test(r.botId) || re.test(r.modelName || "") || re.test(r.provider || ""),
  );
  console.log(`\nentries matching "${TERM}": ${hits.length ? "" : "NONE"}`);
  for (const r of hits) console.log("  ", r);

  const rawHits = [...new Set((js.match(new RegExp(`${TERM}[a-z0-9.\\-]*`, "gi")) || []))];
  console.log(`raw string matches for "${TERM}" anywhere in bundle:`, rawHits.length ? rawHits : "NONE");
}
