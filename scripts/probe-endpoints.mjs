#!/usr/bin/env node
// Reverse-engineers chatplayground's chat-endpoint routing from the public
// bundle so the relay can mirror it. No auth needed — reads public JS only.
//
// Dumps:
//   1. the azure botId allowlist (the `.includes(botId)` routing gate)
//   2. the request-body construction preceding each /api/chat/<endpoint> fetch
//
// Run:  node scripts/probe-endpoints.mjs

const HOMEPAGE = process.env.UPSTREAM_HOMEPAGE ?? "https://web.chatplayground.ai/";

const html = await (await fetch(HOMEPAGE)).text();
const bundleMatch = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
if (!bundleMatch) {
  console.error("bundle URL not found in homepage HTML");
  process.exit(1);
}
const bundleName = bundleMatch[1];
const js = await (await fetch(new URL(`/assets/${bundleName}`, HOMEPAGE))).text();
console.log(`bundle: ${bundleName}  (${js.length} bytes)\n`);

// 1. Dump context around each chat endpoint path string (the fetch + body).
for (const path of ["/api/chat/azure", "/api/chat/perplexity", "/api/chat/lmsys"]) {
  const idx = js.indexOf(path);
  console.log(`=== ${path} @ ${idx} ===`);
  if (idx >= 0) {
    // The fetch body follows the path string; dump forward to capture it whole.
    console.log(js.slice(idx, idx + 700));
  } else {
    console.log("NOT FOUND");
  }
  console.log("");
}

// 2. Dump the routing factory: the array literal feeding `.includes(` that
//    decides azure vs perplexity vs lmsys.
console.log("=== routing factory (.includes + perplexity branch) ===");
let from = 0;
let hits = 0;
while (hits < 6) {
  const i = js.indexOf('perplexity")', from);
  if (i < 0) break;
  const slice = js.slice(Math.max(0, i - 700), i + 120);
  if (slice.includes("includes(")) {
    console.log(`@${i}:`, slice);
    console.log("");
    hits++;
  }
  from = i + 1;
}
