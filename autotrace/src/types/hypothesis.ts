import type { Evidence } from "./evidence.js";

// The five competing explanation families AutoTrace investigates for this case.
export type HypothesisId = "H1" | "H2" | "H3" | "H4" | "H5";

// One competing explanation. A hypothesis is a possible cause under investigation, never a confirmed cause.
export type Hypothesis = {
  id: HypothesisId;
  label: string;
  claim: string;
  possibleCauses: string[];
};

/**
 * How a mention relates to the hypothesis after deterministic polarity classification.
 * "context" means the source discussed the system without establishing fault or clearance.
 * "supports" and "contradicts" are reserved for findings that actually help or hurt the claim.
 */
export type MentionPolarity = "context" | "supports" | "contradicts";

/**
 * Evidence whose text mentions the system a hypothesis is about, plus the terms that linked them.
 * A mention always records that a source discussed the system. Polarity then separates mere
 * context from findings that support or contradict the hypothesis.
 */
export type HypothesisMention = {
  evidence: Evidence;
  matchedTerms: string[];
  polarity: MentionPolarity;
  polarityReason: string;
};

// A hypothesis together with the evidence collected so far that mentions it.
export type HypothesisEvidence = {
  hypothesis: Hypothesis;
  mentions: HypothesisMention[];
};

// All competing hypotheses, plus evidence that mentioned none of them.
export type HypothesisBoard = {
  hypotheses: HypothesisEvidence[];
  unmentionedEvidence: Evidence[];
};
