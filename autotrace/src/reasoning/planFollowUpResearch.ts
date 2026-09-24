import { containsTerm } from "../research/terms.js";
import type { DiagnosticCase, DiagnosticCode } from "../types/diagnosticCase.js";
import type { Hypothesis, HypothesisBoard, HypothesisId } from "../types/hypothesis.js";
import type { InvestigationState } from "../types/investigation.js";
import type { DiagnosticAssessment } from "../types/reasoning.js";
import type { ResearchObjective } from "../types/researchObjective.js";

// Keep follow-up research small so a later round stays focused and reviewable.
const MAX_OBJECTIVES = 3;

// Words that appear on many hypotheses and must not create a relationship by themselves.
const NON_DISTINCTIVE_TERMS = new Set([
  "problem",
  "related",
  "misfire",
  "fault",
  "failed",
  "could",
  "produce",
  "reported",
  "codes",
  "system",
  "engine",
  "cylinder",
  "affected",
  "normal",
  "combustion",
  "without",
  "having",
  "named",
  "component",
  "air",
]);

// Collapse whitespace and case so duplicate unresolved questions collapse to one objective.
function normalizeQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

// Prefer the platform token when present so vehicle wording stays chassis-specific.
function formatVehicle(vehicle: DiagnosticCase["vehicle"]): string {
  const parts = [vehicle.make, vehicle.model];
  if (vehicle.platform) {
    parts.push(vehicle.platform);
  }
  if (vehicle.engine) {
    parts.push(vehicle.engine);
  }
  return parts.join(" ");
}

// Join supplied DTCs for objective wording without inventing codes that were not on the case.
function formatCodes(codes: DiagnosticCode[]): string {
  return codes.map((item) => item.code).filter((code) => code.length > 0).join(", ");
}

// Record a term once when it is distinctive enough to justify a hypothesis link.
function addDistinctiveTerm(terms: string[], candidate: string): void {
  const normalized = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized || NON_DISTINCTIVE_TERMS.has(normalized)) {
    return;
  }
  if (!terms.includes(normalized)) {
    terms.push(normalized);
  }
}

/**
 * Distinctive terms drawn only from the hypothesis board.
 * Label tokens and possible-cause phrases are used; generic words are excluded so links are not guessed.
 */
function distinctiveTerms(hypothesis: Hypothesis): string[] {
  const distinctive: string[] = [];
  const labelText = hypothesis.label
    .toLowerCase()
    .replace(/\b(related|problem|misfire)\b/g, " ");

  for (const token of labelText.split(/[^a-z0-9]+/)) {
    if (token.length >= 3) {
      addDistinctiveTerm(distinctive, token);
    }
  }

  for (const cause of hypothesis.possibleCauses) {
    addDistinctiveTerm(distinctive, cause);
    for (const token of cause.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 5) {
        addDistinctiveTerm(distinctive, token);
      }
    }
  }

  return distinctive;
}

/**
 * Hypothesis ids whose board text clearly appears in the unresolved question.
 * Returns an empty list when the question does not mention a hypothesis system; it does not guess.
 */
function relatedHypothesesForQuestion(
  question: string,
  board: HypothesisBoard
): HypothesisId[] {
  const haystack = question.toLowerCase();
  const related: HypothesisId[] = [];

  for (const entry of board.hypotheses) {
    const terms = distinctiveTerms(entry.hypothesis);
    const matched = terms.some((term) => containsTerm(haystack, term));
    if (matched) {
      related.push(entry.hypothesis.id);
    }
  }

  return related;
}

// Label text for a hypothesis id that is already present on the board.
function hypothesisLabel(board: HypothesisBoard, id: HypothesisId): string | undefined {
  return board.hypotheses.find((entry) => entry.hypothesis.id === id)?.hypothesis.label;
}

/**
 * Turn one unresolved question into a vehicle-specific research ask.
 * The wording requests technical evidence; it does not assert a cause or name a repair.
 */
function buildObjectiveQuestion(
  unresolvedQuestion: string,
  diagnosticCase: DiagnosticCase,
  relatedHypotheses: HypothesisId[],
  board: HypothesisBoard
): string {
  const vehicle = formatVehicle(diagnosticCase.vehicle);
  const codes = formatCodes(diagnosticCase.codes);
  const codePhrase = codes.length > 0 ? codes : "the reported diagnostic codes";

  if (relatedHypotheses.length === 1) {
    const onlyId = relatedHypotheses[0];
    if (onlyId !== undefined) {
      const label = hypothesisLabel(board, onlyId) ?? onlyId;
      return (
        `Find technical evidence relevant to ${label} explanations of ${codePhrase} on the ${vehicle}, ` +
        `especially evidence that helps address: ${unresolvedQuestion}`
      );
    }
  }

  if (relatedHypotheses.length > 1) {
    const labels = relatedHypotheses
      .map((id) => hypothesisLabel(board, id) ?? id)
      .join("; ");
    return (
      `Find technical evidence relevant to these competing explanations (${labels}) of ${codePhrase} ` +
      `on the ${vehicle}, especially evidence that helps address: ${unresolvedQuestion}`
    );
  }

  return (
    `Find technical evidence for the ${vehicle} regarding ${codePhrase} that helps address ` +
    `the unresolved diagnostic question: ${unresolvedQuestion}`
  );
}

/**
 * Explain why the objective exists using assessment support when a relationship is already known.
 * Does not claim the objective will prove a diagnosis.
 */
function buildRationale(
  relatedHypotheses: HypothesisId[],
  assessment: DiagnosticAssessment,
  board: HypothesisBoard
): string {
  if (relatedHypotheses.length === 0) {
    return "This question remains unresolved after the current assessment and needs targeted research.";
  }

  const insufficient = relatedHypotheses.filter((id) => {
    const entry = assessment.hypothesisAssessments.find((item) => item.hypothesisId === id);
    return entry?.support === "insufficient-evidence";
  });

  if (insufficient.length > 0) {
    const labels = insufficient
      .map((id) => hypothesisLabel(board, id) ?? id)
      .join("; ");
    return `Current assessment identifies insufficient evidence for the ${labels} hypothesis.`;
  }

  const labels = relatedHypotheses
    .map((id) => hypothesisLabel(board, id) ?? id)
    .join("; ");
  return `This question remains unresolved and relates to the ${labels} hypothesis under investigation.`;
}

// Drop blank and duplicate unresolved questions while preserving first-seen order.
function uniqueUnresolvedQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const question of questions) {
    const normalized = normalizeQuestion(question);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(question.replace(/\s+/g, " ").trim());
  }

  return unique;
}

/**
 * Convert the current investigation's unresolved questions into bounded research objectives.
 * Pure and deterministic: no Solari calls, no LLM calls, and no diagnosis claims.
 */
export function planFollowUpResearch(state: InvestigationState): ResearchObjective[] {
  if (state.assessment === undefined) {
    return [];
  }

  const unresolved = uniqueUnresolvedQuestions(state.unresolvedQuestions);
  if (unresolved.length === 0) {
    return [];
  }

  const assessment = state.assessment;
  const objectives: ResearchObjective[] = [];

  for (const question of unresolved) {
    if (objectives.length >= MAX_OBJECTIVES) {
      break;
    }

    const relatedHypotheses = relatedHypothesesForQuestion(question, state.hypothesisBoard);
    objectives.push({
      id: `objective-${objectives.length + 1}`,
      question: buildObjectiveQuestion(
        question,
        state.diagnosticCase,
        relatedHypotheses,
        state.hypothesisBoard
      ),
      rationale: buildRationale(relatedHypotheses, assessment, state.hypothesisBoard),
      relatedHypotheses,
    });
  }

  return objectives;
}
