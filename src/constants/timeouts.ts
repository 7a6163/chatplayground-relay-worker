// Network timeouts in milliseconds. Passed to AbortSignal.timeout() on
// every outbound fetch so a hung upstream can't pin a Worker request.

/**
 * Whole-request timeout for chat completions — covers both stream and
 * non-stream paths. Generous because long generations (reasoning models,
 * code) can take minutes. Cuts off slowloris / dead connections.
 */
export const CHAT_TIMEOUT = 5 * 60_000;

/** Upload via /v1/files. Even 20MB images upload in seconds. */
export const UPLOAD_TIMEOUT = 60_000;

/** Model discovery (single /api/models JSON fetch). */
export const DISCOVERY_TIMEOUT = 10_000;
