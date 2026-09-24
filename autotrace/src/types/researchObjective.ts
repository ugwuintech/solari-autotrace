import type { HypothesisId } from "./hypothesis.js";

/**
 * A bounded follow-up research target derived from an unresolved investigation question.
 * It describes what to investigate next; it is not a diagnosis, search-engine command, or repair order.
 */
export type ResearchObjective = {
  id: string;
  question: string;
  rationale: string;
  relatedHypotheses: HypothesisId[];
};
