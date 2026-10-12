import { trace } from "neatlogs";
import type { LlmUsage } from "./litellm.js";

export type LlmCallDetails = {
  provider: string;
  model: string;
  temperature: number;
  messages: { role: string; content: string }[];
  // Which structured-output mode this attempt used, when the provider tries more than one.
  responseFormat?: string;
};

export type LlmCallResult = {
  content: string;
  usage?: LlmUsage;
};

/**
 * Record one raw-fetch model request as a Neatlogs LLM span.
 * The SDK does not instrument fetch, so the request messages, reply, and token usage are attached
 * here using the SDK's own attribute keys. Errors propagate unchanged and are recorded on the span.
 */
export function traceLlmCall(
  details: LlmCallDetails,
  call: () => Promise<LlmCallResult>
): Promise<LlmCallResult> {
  return trace({ name: `${details.provider}.chat`, kind: "LLM" }, async (span) => {
    span.setAttribute("neatlogs.llm.provider", details.provider);
    span.setAttribute("neatlogs.llm.model_name", details.model);
    span.setAttribute("neatlogs.llm.temperature", details.temperature);
    if (details.responseFormat) {
      span.setAttribute("autotrace.llm.response_format", details.responseFormat);
    }
    for (const [index, message] of details.messages.entries()) {
      span.setAttribute(`neatlogs.llm.input_messages.${index}.role`, message.role);
      span.setAttribute(`neatlogs.llm.input_messages.${index}.content`, message.content);
    }

    const result = await call();

    span.setAttribute("neatlogs.llm.output_messages.0.role", "assistant");
    span.setAttribute("neatlogs.llm.output_messages.0.content", result.content);
    if (result.usage) {
      span.setAttribute("neatlogs.llm.token_count.prompt", result.usage.promptTokens);
      span.setAttribute("neatlogs.llm.token_count.completion", result.usage.completionTokens);
      span.setAttribute("neatlogs.llm.token_count.total", result.usage.totalTokens);
    }
    return result;
  });
}
