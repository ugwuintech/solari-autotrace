import type { DiagnosticAssessment, ReasoningRequest } from "../types/reasoning.js";
import { parseAssessment } from "./parseAssessment.js";
import { buildReasoningPrompt } from "./prompt.js";
import type { LlmProvider } from "./provider.js";
import { buildAssessmentSchema } from "./responseSchema.js";
import { traceLlmCall } from "./traceLlmCall.js";

// The neatHack LiteLLM gateway: one OpenAI-compatible endpoint in front of Claude and Nova models.
const DEFAULT_BASE_URL = "https://litellm.vision.aivar.app/v1";
const DEFAULT_MODEL = "claude-sonnet-4.6";

// A hosted model answers in seconds to a couple of minutes; anything longer is a stalled request.
const REQUEST_TIMEOUT_MS = 300_000;

export type LiteLlmProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  // Injectable so unit tests never touch the network.
  fetch?: typeof fetch;
};

/** Token counts reported by the gateway for one completion, when it reports them. */
export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LiteLlmCompletion = {
  content: string;
  usage?: LlmUsage;
};

// Identify the provider and the model behind an assessment, e.g. "litellm-claude-sonnet-4-6".
function providerName(model: string): string {
  return `litellm-${model.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function readNumber(record: object, key: string): number | undefined {
  const value = key in record ? (record as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" ? value : undefined;
}

// Read token usage out of an OpenAI-style response without trusting its shape.
function readUsage(payload: object): LlmUsage | undefined {
  const usage = "usage" in payload ? payload.usage : undefined;
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }

  const promptTokens = readNumber(usage, "prompt_tokens");
  const completionTokens = readNumber(usage, "completion_tokens");
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: readNumber(usage, "total_tokens") ?? promptTokens + completionTokens,
  };
}

/**
 * Read the first choice's message content out of an OpenAI-style chat completion.
 * Exported for unit tests; the shape is checked rather than assumed.
 */
export function readCompletion(payload: unknown): LiteLlmCompletion {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("LiteLLM response was not a JSON object");
  }

  const choices = "choices" in payload ? payload.choices : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = typeof first === "object" && first !== null && "message" in first ? first.message : undefined;
  const content =
    typeof message === "object" && message !== null && "content" in message ? message.content : undefined;

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("LiteLLM response contained no message content");
  }

  const usage = readUsage(payload);
  return usage ? { content, usage } : { content };
}

/**
 * A hosted, LiteLLM-backed implementation of the reasoning contract.
 * It sends the same prompt and JSON schema as the Ollama provider and validates the reply with the
 * same parser, so swapping providers changes the model, never the rules evidence must satisfy.
 */
export function createLiteLlmProvider(options: LiteLlmProviderOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env.LITELLM_API_KEY;
  const baseUrl = (options.baseUrl ?? process.env.LITELLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? process.env.LITELLM_MODEL ?? DEFAULT_MODEL;
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${baseUrl}/chat/completions`;
  const name = providerName(model);

  if (!apiKey) {
    throw new Error("LITELLM_API_KEY is not set. Add it to autotrace/.env to use the LiteLLM provider.");
  }

  return {
    name,

    async reason(request: ReasoningRequest): Promise<DiagnosticAssessment> {
      const { system, user } = buildReasoningPrompt(request);

      const body = {
        model,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: { name: "diagnostic_assessment", schema: buildAssessmentSchema(request) },
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };

      try {
        const details = { provider: "litellm", model, temperature: body.temperature, messages: body.messages };
        const completion = await traceLlmCall(details, async () => {
          let response: Response;
          try {
            response = await doFetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`could not reach LiteLLM at ${endpoint}: ${reason}`);
          }

          if (!response.ok) {
            const detail = (await response.text()).trim().slice(0, 500);
            throw new Error(`LiteLLM returned ${response.status} ${response.statusText}: ${detail}`);
          }

          return readCompletion(await response.json());
        });
        return parseAssessment(completion.content, request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AutoTrace reasoning failed:\nProvider: ${name}\nEndpoint: ${endpoint}\nModel: ${model}\nReason: ${reason}`
        );
      }
    },
  };
}
