import type { DiagnosticCase } from "./diagnosticCase.js";
import type { Evidence } from "./evidence.js";
import type { HypothesisBoard, HypothesisId } from "./hypothesis.js";

/**
 * Everything a reasoning model is given about one investigation.
 * The board partitions the collected evidence per hypothesis, while `evidence` stays the canonical
 * list of what research actually found, so an assessment can only reference collected sources.
 * Nothing provider-specific belongs here: no prompts, models, temperatures, or transport options.
 */
export type ReasoningRequest = {
  diagnosticCase: DiagnosticCase;
  board: HypothesisBoard;
  evidence: Evidence[];
};

/**
 * How well the collected evidence stands behind one hypothesis.
 * These are qualitative judgements about the available evidence, not measured probabilities, and
 * "insufficient-evidence" is a valid outcome that must stay distinguishable from weak support.
 */
export type EvidenceSupport =
  | "strongly-supported"
  | "moderately-supported"
  | "weakly-supported"
  | "contradicted"
  | "insufficient-evidence";

// A pointer back to one collected Evidence item, so every claim stays traceable to its source URL.
export type EvidenceReference = {
  title: string;
  url: string;
};

// One hypothesis judged against the evidence, with the sources behind the judgement.
export type HypothesisAssessment = {
  hypothesisId: HypothesisId;
  support: EvidenceSupport;
  explanation: string;
  supportingEvidence: EvidenceReference[];
  contradictingEvidence: EvidenceReference[];
};

// Sources that disagree, recorded rather than silently resolved in favour of one of them.
export type EvidenceConflict = {
  description: string;
  references: EvidenceReference[];
  affectedHypotheses: HypothesisId[];
};

// A question the collected evidence cannot answer yet, kept visible instead of being guessed at.
export type DiagnosticUnknown = {
  question: string;
  whyItMatters: string;
};

/**
 * The next diagnostic test to perform, preferred over recommending parts replacement.
 * `distinguishes` names the hypotheses the result would separate, which is what makes the test
 * worth performing next rather than merely related to the fault.
 */
export type RecommendedTest = {
  name: string;
  purpose: string;
  procedure: string[];
  distinguishes: HypothesisId[];
};

/**
 * A structured diagnostic assessment of one investigation at a point in time.
 * It deliberately has no ranking, winner, or numeric confidence field: several hypotheses may remain
 * open, and the assessment describes what the evidence shows plus the test that would narrow it down.
 */
export type DiagnosticAssessment = {
  hypothesisAssessments: HypothesisAssessment[];
  conflicts: EvidenceConflict[];
  unknowns: DiagnosticUnknown[];
  recommendedNextTest: RecommendedTest;
  reasoning: string;
};
