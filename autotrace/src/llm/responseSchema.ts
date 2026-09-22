import type { JsonSchema } from "../types/jsonSchema.js";
import type { ReasoningRequest } from "../types/reasoning.js";

const SUPPORT_VALUES = [
  "strongly-supported",
  "moderately-supported",
  "weakly-supported",
  "contradicted",
  "insufficient-evidence",
];

// Restrict a string to the supplied options. With nothing to choose from the field stays a plain
// string and validation rejects whatever the model puts there, which is the correct outcome.
function enumOrString(values: string[]): JsonSchema {
  const unique = Array.from(new Set(values));
  return unique.length > 0 ? { type: "string", enum: unique } : { type: "string" };
}

/**
 * The JSON schema for a DiagnosticAssessment produced from one specific request.
 * Hypothesis identifiers, evidence titles, and evidence URLs are restricted to what was actually
 * supplied, so the model cannot generate a citation to a source that does not exist. This narrows
 * what the model can emit; it does not replace validation of the parsed response.
 */
export function buildAssessmentSchema(request: ReasoningRequest): JsonSchema {
  const hypothesisIds = request.board.hypotheses.map((entry) => entry.hypothesis.id);
  const hypothesisId = enumOrString(hypothesisIds);

  const evidenceReference: JsonSchema = {
    type: "object",
    properties: {
      title: enumOrString(request.evidence.map((item) => item.title)),
      url: enumOrString(request.evidence.map((item) => item.url)),
    },
    required: ["title", "url"],
  };

  const evidenceReferences: JsonSchema = { type: "array", items: evidenceReference };

  return {
    type: "object",
    properties: {
      hypothesisAssessments: {
        type: "array",
        minItems: hypothesisIds.length,
        maxItems: hypothesisIds.length,
        items: {
          type: "object",
          properties: {
            hypothesisId,
            support: { type: "string", enum: SUPPORT_VALUES },
            explanation: { type: "string" },
            supportingEvidence: evidenceReferences,
            contradictingEvidence: evidenceReferences,
          },
          required: ["hypothesisId", "support", "explanation", "supportingEvidence", "contradictingEvidence"],
        },
      },
      conflicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            references: evidenceReferences,
            affectedHypotheses: { type: "array", items: hypothesisId },
          },
          required: ["description", "references", "affectedHypotheses"],
        },
      },
      unknowns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            whyItMatters: { type: "string" },
          },
          required: ["question", "whyItMatters"],
        },
      },
      recommendedNextTest: {
        type: "object",
        properties: {
          name: { type: "string" },
          purpose: { type: "string" },
          procedure: { type: "array", minItems: 1, items: { type: "string" } },
          distinguishes: { type: "array", items: hypothesisId },
        },
        required: ["name", "purpose", "procedure", "distinguishes"],
      },
      reasoning: { type: "string" },
    },
    required: ["hypothesisAssessments", "conflicts", "unknowns", "recommendedNextTest", "reasoning"],
  };
}
