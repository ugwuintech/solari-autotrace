import type { InvestigationResult } from "../agent/investigate.js";
import type { HypothesisBoard, HypothesisId } from "../types/hypothesis.js";
import type { EvidenceSupport } from "../types/reasoning.js";
import type {
  InvestigationUiResult,
  UiEvidenceItem,
  UiHypothesis,
  UiRecommendedTest,
  UiSourceLink,
} from "../types/ui.js";

const SUPPORT_LABELS: Record<EvidenceSupport, string> = {
  "strongly-supported": "Strongly supported",
  "moderately-supported": "Moderately supported",
  "weakly-supported": "Weakly supported",
  contradicted: "Contradicted",
  "insufficient-evidence": "Insufficient evidence",
};

export const DIAGNOSTIC_DISCLAIMER =
  "This is a research-based assessment, not a confirmed diagnosis. Physical inspection and diagnostic testing are required.";

// Resolve a hypothesis id to the board label used in the tester UI.
function hypothesisLabel(board: HypothesisBoard, id: HypothesisId): string {
  const entry = board.hypotheses.find((item) => item.hypothesis.id === id);
  return entry?.hypothesis.label ?? id;
}

// Map assessment source pointers into UI source links.
function mapSourceLinks(
  references: Array<{ title: string; url: string }>
): UiSourceLink[] {
  return references.map((reference) => ({
    title: reference.title,
    url: reference.url,
  }));
}

// Build the hypothesis list from the board, merging Qwen assessment when present.
function mapHypotheses(result: InvestigationResult): UiHypothesis[] {
  const { hypothesisBoard, assessment } = result.state;
  const assessments = new Map(
    (assessment?.hypothesisAssessments ?? []).map((item) => [item.hypothesisId, item])
  );

  return hypothesisBoard.hypotheses.map((entry) => {
    const item = assessments.get(entry.hypothesis.id);
    return {
      id: entry.hypothesis.id,
      label: entry.hypothesis.label,
      support: item?.support ?? null,
      supportLabel: item ? SUPPORT_LABELS[item.support] : "No assessment yet",
      explanation: item?.explanation ?? "No diagnostic assessment was produced for this hypothesis.",
      supportingEvidence: item ? mapSourceLinks(item.supportingEvidence) : [],
      contradictingEvidence: item ? mapSourceLinks(item.contradictingEvidence) : [],
      mentions: entry.mentions.map((mention) => ({
        title: mention.evidence.title,
        url: mention.evidence.url,
        finding: mention.evidence.finding,
        polarity: mention.polarity,
        polarityReason: mention.polarityReason,
      })),
    };
  });
}

// Copy evidence into the UI-facing list without exposing extraction internals.
function mapEvidence(result: InvestigationResult): UiEvidenceItem[] {
  return result.state.evidence.map((item) => ({
    title: item.title,
    url: item.url,
    finding: item.finding,
    relevance: item.relevance,
  }));
}

// Map the recommended next test, preserving hypothesis labels for display.
function mapRecommendedTest(result: InvestigationResult): UiRecommendedTest | null {
  const test = result.state.assessment?.recommendedNextTest;
  if (!test) {
    return null;
  }

  return {
    name: test.name,
    purpose: test.purpose,
    procedure: [...test.procedure],
    distinguishes: test.distinguishes.map(
      (id) => `${id} — ${hypothesisLabel(result.state.hypothesisBoard, id)}`
    ),
  };
}

/**
 * Convert a completed InvestigationResult into the JSON shape rendered by the tester UI.
 * Does not invent findings; it only reshapes data already produced by runInvestigation.
 */
export function mapInvestigationResult(result: InvestigationResult): InvestigationUiResult {
  const { state } = result;
  const assessment = state.assessment;

  return {
    summary: {
      researchRounds: state.researchRound,
      evidenceCount: state.evidence.length,
      unresolvedQuestionCount: state.unresolvedQuestions.length,
      reasoningProvider: result.providerName,
      status: state.status,
    },
    hypotheses: mapHypotheses(result),
    evidence: mapEvidence(result),
    unknowns: (assessment?.unknowns ?? []).map((item) => ({
      question: item.question,
      whyItMatters: item.whyItMatters,
    })),
    recommendedNextTest: mapRecommendedTest(result),
    reasoning: assessment?.reasoning ?? null,
    disclaimer: DIAGNOSTIC_DISCLAIMER,
    ...(result.reassessmentError !== undefined
      ? { reassessmentError: result.reassessmentError }
      : {}),
  };
}
