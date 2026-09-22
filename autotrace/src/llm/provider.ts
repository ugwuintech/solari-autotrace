import type { DiagnosticAssessment, ReasoningRequest } from "../types/reasoning.js";

/**
 * The reasoning capability AutoTrace needs from a language model.
 * The rest of the application depends on this contract only, so a local Qwen/Ollama provider during
 * development and a hosted provider later are interchangeable. Implementations own prompting,
 * transport, and validation of the model output, and must build the assessment from the evidence
 * supplied in the request rather than from model recall.
 */
export interface LlmProvider {
  // Identifies the provider in logs and error messages so reasoning stays attributable.
  readonly name: string;

  // Produce a structured diagnostic assessment of the case, hypotheses, and evidence supplied.
  reason(request: ReasoningRequest): Promise<DiagnosticAssessment>;
}
