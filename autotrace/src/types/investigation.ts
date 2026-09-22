import type { DiagnosticCase } from "./diagnosticCase.js";
import type { Evidence } from "./evidence.js";
import type { HypothesisBoard } from "./hypothesis.js";
import type { DiagnosticAssessment } from "./reasoning.js";

/**
 * Where one investigation sits in the research → assess → follow-up cycle.
 * Kept as an explicit union so later loop logic cannot invent ad-hoc status strings.
 */
export type InvestigationStatus =
  | "researching"
  | "assessing"
  | "needs-follow-up"
  | "complete";

/**
 * Accumulated state for one diagnostic investigation across research rounds.
 * Reuses the existing case, evidence, board, and assessment types; it does not duplicate
 * assessment.unknowns — unresolvedQuestions is the working list of open questions that may
 * drive a later follow-up research round.
 */
export type InvestigationState = {
  diagnosticCase: DiagnosticCase;
  evidence: Evidence[];
  hypothesisBoard: HypothesisBoard;
  assessment?: DiagnosticAssessment;
  researchRound: number;
  attemptedQueries: string[];
  unresolvedQuestions: string[];
  status: InvestigationStatus;
};
