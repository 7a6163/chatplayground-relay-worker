// web.chatplayground.ai POST /api/chat request body. Captured from the web
// client (DevTools + its bundled zod schema).
export interface UpstreamChatRequest {
  modelSlug: string;
  // Per send. The web client shares one across the panels of a multi-model
  // send; a single relay call is its own submission.
  submissionId: string;
  // attachments: fileIds from the presign → PUT → complete upload flow
  message: { text: string; attachments?: { fileId: string }[] };
  conversationId?: string; // continue an existing chat (history kept upstream)
  noSave: boolean;
}

// One `data:` event of the reply. It is a Vercel AI SDK UI-message stream:
// start / start-step / reasoning-* / text-start / text-delta / text-end /
// source-url / source-document / error / abort / finish-step / finish, then
// `[DONE]`. Fields are typed loosely because they are untrusted — each use
// checks its own.
export interface UpstreamEvent {
  type: string;
  delta?: unknown; // text-delta, reasoning-delta
  url?: unknown; // source-url
  errorText?: unknown; // error
  messageMetadata?: {
    // finish
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      reasoningTokens?: unknown;
    };
  };
}
