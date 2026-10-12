import { span } from "neatlogs";
import { parseAssessment } from "./parseAssessment.js";

/**
 * parseAssessment recorded as a Neatlogs guardrail span.
 * A rejected model reply (bad JSON, unknown hypothesis, citation to evidence that was never collected)
 * shows up as a failed guardrail rather than only as an error on the whole investigation.
 * The input is not captured because the model reply is already on the LLM span.
 */
export const validateAssessment = span(
  { kind: "GUARDRAIL", name: "validate_assessment", captureInput: false },
  parseAssessment
);
