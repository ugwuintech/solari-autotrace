import type { JsonSchema } from "../types/jsonSchema.js";
import type { DiagnosticAssessment, ReasoningRequest } from "../types/reasoning.js";
import type { RecoveryRecorder } from "../types/recovery.js";
import { validateAssessment } from "./validateAssessment.js";
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
  // Told about every failed attempt the provider recovered from.
  onRecovery?: RecoveryRecorder;
};

type ChatMessage = { role: "system" | "user"; content: string };

type ResponseFormat = { label: string; value: unknown };

/** A non-2xx gateway reply, kept structured so the caller can decide whether another attempt makes sense. */
class GatewayError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly detail: string
  ) {
    super(`LiteLLM returned ${status} ${statusText}: ${detail}`);
  }
}

/**
 * Drop array-length bounds from a schema. Some backends (Bedrock's structured output) only accept
 * minItems of 0 or 1, so the bounds are removed here and enforced by parseAssessment instead,
 * which already rejects an assessment that does not cover every hypothesis exactly once.
 */
export function relaxSchema(schema: JsonSchema): JsonSchema {
  const { minItems: _minItems, maxItems: _maxItems, properties, items, ...rest } = schema;
  const relaxed: JsonSchema = { ...rest };
  if (properties) {
    relaxed.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, relaxSchema(value)])
    );
  }
  if (items) {
    relaxed.items = relaxSchema(items);
  }
  return relaxed;
}

/**
 * Response formats to try, strictest first. Each fallback asks the backend to enforce less while
 * generating; none of them changes what the reply must satisfy, because every reply is validated.
 */
export function responseFormats(schema: JsonSchema): ResponseFormat[] {
  const jsonSchema = (value: JsonSchema) => ({
    type: "json_schema",
    json_schema: { name: "diagnostic_assessment", schema: value },
  });
  return [
    { label: "json_schema", value: jsonSchema(schema) },
    { label: "json_schema without array-length bounds", value: jsonSchema(relaxSchema(schema)) },
    { label: "json_object", value: { type: "json_object" } },
  ];
}

// A 400 that names the schema or response format means the backend refused the format, not the request.
function isFormatRejection(error: GatewayError): boolean {
  return error.status === 400 && /schema|response_format|output_config|format/i.test(error.detail);
}

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

  // Index into responseFormats() of the strictest format the backend has accepted so far.
  let acceptedFormatIndex = 0;

  // Send one chat completion with the given response format and read the reply.
  async function complete(messages: ChatMessage[], format: ResponseFormat): Promise<LiteLlmCompletion> {
    const body = { model, temperature: 0, response_format: format.value, messages };

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
      throw new GatewayError(response.status, response.statusText, detail);
    }

    return readCompletion(await response.json());
  }

  return {
    name,

    async reason(request: ReasoningRequest): Promise<DiagnosticAssessment> {
      const { system, user } = buildReasoningPrompt(request);
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      const formats = responseFormats(buildAssessmentSchema(request));

      try {
        let completion: LiteLlmCompletion | undefined;
        // Start from the format this backend last accepted, so a refusal costs one call per run, not per round.
        for (let index = acceptedFormatIndex; index < formats.length; index += 1) {
          const format = formats[index];
          if (!format) {
            break;
          }
          const details = { provider: "litellm", model, temperature: 0, messages, responseFormat: format.label };
          try {
            completion = await traceLlmCall(details, () => complete(messages, format));
            acceptedFormatIndex = index;
            break;
          } catch (error) {
            // Only a refused response format is worth another attempt; anything else is a real failure.
            const next = formats[index + 1];
            if (!(error instanceof GatewayError) || !isFormatRejection(error) || !next) {
              throw error;
            }
            options.onRecovery?.({
              step: "reasoning",
              failure: `${model} rejected the ${format.label} response format: ${error.detail.slice(0, 240)}`,
              action: `retried with ${next.label}; the reply is still validated against the full assessment rules`,
            });
          }
        }

        if (!completion) {
          throw new Error("no response format was accepted");
        }
        return validateAssessment(completion.content, request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AutoTrace reasoning failed:\nProvider: ${name}\nEndpoint: ${endpoint}\nModel: ${model}\nReason: ${reason}`
        );
      }
    },
  };
}
