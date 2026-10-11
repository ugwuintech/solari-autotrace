import { createLiteLlmProvider } from "./litellm.js";
import { createOllamaProvider } from "./ollama.js";
import type { LlmProvider } from "./provider.js";

/**
 * Choose the reasoning provider from AUTOTRACE_LLM.
 * "ollama" (the default) keeps reasoning on the local Qwen model; "litellm" uses the hosted gateway.
 */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const choice = (env.AUTOTRACE_LLM ?? "ollama").trim().toLowerCase();

  if (choice === "ollama") {
    return createOllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL });
  }
  if (choice === "litellm") {
    return createLiteLlmProvider({
      apiKey: env.LITELLM_API_KEY ?? "",
      baseUrl: env.LITELLM_BASE_URL,
      model: env.LITELLM_MODEL,
    });
  }

  throw new Error(`Unknown AUTOTRACE_LLM "${choice}". Use "ollama" or "litellm".`);
}
