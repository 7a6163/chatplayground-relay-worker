import type { OpenAIErrorEnvelope } from "../types/openai";

export class OpenAIHTTPError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly type: string,
    public readonly code: string | null = null,
    public readonly param: string | null = null,
  ) {
    super(message);
    this.name = "OpenAIHTTPError";
  }

  toEnvelope(): OpenAIErrorEnvelope {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        param: this.param,
      },
    };
  }
}

export function invalidRequest(
  message: string,
  param: string | null = null,
): OpenAIHTTPError {
  return new OpenAIHTTPError(
    400,
    message,
    "invalid_request_error",
    null,
    param,
  );
}

export function unauthorized(message: string): OpenAIHTTPError {
  return new OpenAIHTTPError(
    401,
    message,
    "invalid_request_error",
    "invalid_api_key",
  );
}

export function modelNotFound(model: string): OpenAIHTTPError {
  return new OpenAIHTTPError(
    404,
    `Model '${model}' not found. Call GET /v1/models for the list of available models.`,
    "invalid_request_error",
    "model_not_found",
    "model",
  );
}

export function upstreamError(
  upstreamStatus: number,
  message: string,
): OpenAIHTTPError {
  return new OpenAIHTTPError(
    502,
    message,
    "upstream_error",
    `upstream_${upstreamStatus}`,
  );
}
