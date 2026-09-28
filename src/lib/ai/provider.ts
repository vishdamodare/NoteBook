import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { serverEnv } from "@/lib/env";

export type AiErrorCode = "not_configured" | "rate_limited" | "context_length" | "provider_error";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  name: string;
  system: string;
  user: string;
}

/**
 * Provider-agnostic structured generation. Implementations return the raw,
 * *unvalidated* object: callers must validate it before use.
 */
export interface AiProvider {
  readonly model: string;
  generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<unknown>;
}

class OpenAiProvider implements AiProvider {
  private client: OpenAI;
  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async generate<S extends z.ZodType>({ schema, name, system, user }: StructuredRequest<S>): Promise<unknown> {
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        text: { format: zodTextFormat(schema, name) },
      });
      return response.output_parsed;
    } catch (error) {
      if (error instanceof OpenAI.RateLimitError) {
        throw new AiError("rate_limited", "The AI service is busy. Please try again in a minute.");
      }
      if (error instanceof OpenAI.APIError && /context|too long|maximum/i.test(error.message)) {
        throw new AiError("context_length", "This transcript is too long for the configured model.");
      }
      if (error instanceof OpenAI.APIError) {
        console.error("[ai] provider error", { status: error.status, type: error.type });
        throw new AiError("provider_error", "The AI service returned an error.");
      }
      // Parse failures from the SDK (invalid JSON etc.) fall through to validation.
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
}

export function createAiProvider(): AiProvider {
  const { openaiApiKey, openaiModel } = serverEnv;
  if (!openaiApiKey || !openaiModel) {
    throw new AiError("not_configured", "AI summaries aren't configured on this server (OPENAI_API_KEY / OPENAI_MODEL).");
  }
  return new OpenAiProvider(openaiApiKey, openaiModel);
}
