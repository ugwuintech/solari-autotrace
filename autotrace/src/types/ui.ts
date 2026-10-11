import type { ProgressEvent } from "./progress.js";
import type { RecoveryEvent } from "./recovery.js";
import type { EvidenceRelevance } from "./evidence.js";
import type { MentionPolarity } from "./hypothesis.js";
import type { EvidenceSupport } from "./reasoning.js";

// Raw form fields submitted by the tester UI before conversion to DiagnosticCase.
export type InvestigationFormInput = {
  vehicle: string;
  codes: string;
  symptoms: string;
};

// One clickable source shown in the tester UI.
export type UiSourceLink = {
  title: string;
  url: string;
};

// Evidence row rendered in the tester UI, including extraction-time relevance.
export type UiEvidenceItem = {
  title: string;
  url: string;
  finding: string;
  relevance: EvidenceRelevance;
};

// Hypothesis mention with deterministic polarity for UI display.
export type UiHypothesisMention = {
  title: string;
  url: string;
  finding: string;
  polarity: MentionPolarity;
  polarityReason: string;
};

// One competing hypothesis as shown in the tester, with assessment and polarity when available.
export type UiHypothesis = {
  id: string;
  label: string;
  support: EvidenceSupport | null;
  supportLabel: string;
  explanation: string;
  supportingEvidence: UiSourceLink[];
  contradictingEvidence: UiSourceLink[];
  mentions: UiHypothesisMention[];
};

// Recommended diagnostic test copied from the assessment for the tester UI.
export type UiRecommendedTest = {
  name: string;
  purpose: string;
  procedure: string[];
  distinguishes: string[];
};

// Investigation summary strip shown at the top of the result view.
export type UiInvestigationSummary = {
  researchRounds: number;
  evidenceCount: number;
  unresolvedQuestionCount: number;
  reasoningProvider: string;
  status: string;
};

/**
 * JSON shape returned to the tester UI after a real investigation completes.
 * Keeps the page free of raw orchestration internals while preserving evidence URLs and polarity.
 */
export type InvestigationUiResult = {
  summary: UiInvestigationSummary;
  hypotheses: UiHypothesis[];
  evidence: UiEvidenceItem[];
  unknowns: Array<{ question: string; whyItMatters: string }>;
  recommendedNextTest: UiRecommendedTest | null;
  reasoning: string | null;
  disclaimer: string;
  /** Failed actions the agent recovered from during this investigation. */
  recoveries: RecoveryEvent[];
  /** Present when round-2 reassessment failed; round-1 assessment was retained. */
  reassessmentError?: string;
};

// Structured validation or investigation failure returned to the tester UI.
export type InvestigationUiError = {
  error: string;
  detail?: string;
};

/**
 * One line of the streamed investigation response (Accept: application/x-ndjson).
 * Progress lines describe real pipeline steps; the stream ends with exactly one result or error line.
 */
export type InvestigationStreamMessage =
  | { type: "progress"; event: ProgressEvent }
  | { type: "result"; result: InvestigationUiResult }
  | ({ type: "error"; statusCode: number } & InvestigationUiError);
