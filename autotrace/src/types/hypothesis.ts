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
 * Evidence whose text mentions the system a hypothesis is about, plus the terms that linked them.
 * A mention records only that a source discussed the system. It is not support for the hypothesis:
 * deciding whether evidence supports or contradicts a hypothesis belongs to evidence evaluation.
 */
export type HypothesisMention = {
  evidence: Evidence;
  matchedTerms: string[];
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
