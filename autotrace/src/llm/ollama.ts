import type { DiagnosticAssessment, ReasoningRequest } from "../types/reasoning.js";
import { parseAssessment } from "./parseAssessment.js";
import { buildReasoningPrompt } from "./prompt.js";
import type { LlmProvider } from "./provider.js";
import { buildAssessmentSchema } from "./responseSchema.js";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3:4b";

// A local model on consumer hardware is slow rather than unresponsive, so the ceiling is generous.
const REQUEST_TIMEOUT_MS = 600_000;

export type OllamaProviderOptions = {
  baseUrl?: string;
  model?: string;
};

// Identify the provider and the model behind an assessment, e.g. "ollama-qwen3-4b".
function providerName(model: string): string {
  return `ollama-${model.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

// Read the message content out of one streamed chat response line without trusting its shape.
function readStreamedLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return "";
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new Error(`Ollama sent a response line that was not JSON: ${trimmed.slice(0, 200)}`);
  }

  if (typeof payload !== "object" || payload === null) {
    throw new Error("Ollama sent a response line that was not a JSON object");
  }

  const failure = "error" in payload ? payload.error : undefined;
  if (typeof failure === "string") {
    throw new Error(`Ollama reported an error: ${failure}`);
  }

  const message = "message" in payload ? payload.message : undefined;
  if (typeof message !== "object" || message === null) {
    return "";
  }

  const content = "content" in message ? message.content : undefined;
  return typeof content === "string" ? content : "";
}

/**
 * Collect a streamed Ollama chat response into the complete message content.
 * The response is streamed because a local model can spend several minutes on one assessment, and a
 * non-streamed request would sit past the HTTP client's response timeout before any byte arrives.
 * Streaming is a transport detail only: the assessment is still parsed from the finished document.
 */
async function readStreamedContent(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error("Ollama returned an empty response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // The final element is whatever arrived after the last newline, so it may be a partial line.
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      content += readStreamedLine(line);
    }
  }

  content += readStreamedLine(buffer);

  if (content.trim().length === 0) {
    throw new Error("Ollama response contained no message content");
  }

  return content;
}

/**
 * Send one chat completion to the local Ollama HTTP API and return the raw message content.
 * The schema is supplied as the response format, so the model is constrained to the assessment
 * shape while generating rather than only being asked for it.
 */
async function requestCompletion(
  endpoint: string,
  body: Record<string, unknown>,
  model: string
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not reach Ollama at ${endpoint} (is it running?): ${reason}`);
  }

  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`Ollama returned ${response.status} ${response.statusText} for model ${model}: ${detail}`);
  }

  return readStreamedContent(response);
}

/**
 * A local Ollama-backed implementation of the reasoning contract.
 * The provider is a pure request/response step: it prompts the model with the case, hypotheses, and
 * collected evidence, constrains the reply to the DiagnosticAssessment schema, and validates what
 * comes back. It performs no research, uses no tools, and never retries in a way that would change
 * what the model was asked, so the same request produces the same kind of structured answer.
 */
export function createOllamaProvider(options: OllamaProviderOptions = {}): LlmProvider {
  const baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  const endpoint = `${baseUrl}/api/chat`;
  const name = providerName(model);

  return {
    name,

    async reason(request: ReasoningRequest): Promise<DiagnosticAssessment> {
      const { system, user } = buildReasoningPrompt(request);

      const body = {
        model,
        // Streamed for transport reasons only; the reply is reassembled before it is parsed.
        stream: true,
        // Qwen3 is a thinking model. AutoTrace wants the assessment, not the deliberation.
        think: false,
        format: buildAssessmentSchema(request),
        options: { temperature: 0 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };

      try {
        const content = await requestCompletion(endpoint, body, model);
        return parseAssessment(content, request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AutoTrace reasoning failed:\nProvider: ${name}\nEndpoint: ${endpoint}\nModel: ${model}\nReason: ${reason}`
        );
      }
    },
  };
}
