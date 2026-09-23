import { containsTerm } from "../research/terms.js";
import type { MentionPolarity } from "../types/hypothesis.js";

/**
 * Result of classifying how a finding relates to one hypothesis it mentions.
 * Polarity is per (evidence, hypothesis) pair: the same source can support one family and
 * contradict another. A reason string keeps the rule that fired explainable in tests and prompts.
 */
export type MentionPolarityResult = {
  polarity: MentionPolarity;
  reason: string;
};

// Verbs that record a prior diagnostic action on a named component or system.
const INTERVENTION_PATTERN =
  /\b(?:swapped|replaced|tested|checked|inspected|cleaned|ruled\s+out|was\s+moved|were\s+moved)\b/;

// Phrases that say the fault remained after an intervention or check.
const PERSISTENCE_PATTERNS: RegExp[] = [
  /\bno\s+change\b/,
  /\bstill\s+(?:has\s+)?(?:p\d{4}|misfire|code|codes)\b/,
  /\b(?:misfire|problem|code|fault)\s+remained\b/,
  /\bdid\s+not\s+follow\b/,
  /\bcontinued\s+(?:to\s+)?(?:misfire|misfiring)\b/,
  /\bdid\s+not\s+(?:resolve|clear|fix|go\s+away)\b/,
  /\bsame\s+(?:code|misfire|problem)\b/,
];

// Compression measured normal/equal — a negative finding for a mechanical hypothesis.
const NORMAL_COMPRESSION_PATTERNS: RegExp[] = [
  /\bcompression\s+(?:was\s+|is\s+|were\s+)?(?:equal|normal|good|fine|ok|okay|even|within\s+spec)\b/,
  /\b(?:equal|normal|good|even)\s+compression\b/,
];

// Fault adjectives that, next to a matched system term, count as supporting findings.
const FAULT_ADJECTIVE_PATTERN =
  /\b(?:failed|bad|faulty|defective|dead|clogged|leaking|shorted|cracked|fouled|worn|broken)\b/;

// True when the haystack reports normal or equal compression.
function hasNormalCompression(haystack: string): boolean {
  return NORMAL_COMPRESSION_PATTERNS.some((pattern) => pattern.test(haystack));
}

// True when the haystack records a diagnostic intervention on some component.
function hasIntervention(haystack: string): boolean {
  return INTERVENTION_PATTERN.test(haystack);
}

// True when the haystack says the problem remained after prior work.
function hasPersistence(haystack: string): boolean {
  return PERSISTENCE_PATTERNS.some((pattern) => pattern.test(haystack));
}

// True when any matched term is a compression-related measurement term.
function hasCompressionTerm(matchedTerms: string[]): boolean {
  return matchedTerms.some((term) => {
    const lower = term.toLowerCase();
    return lower.includes("compression") || lower.includes("leak");
  });
}

// Split finding text on sentence boundaries so multi-finding reports can be judged per sentence.
function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|;\s+/)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter((clause) => clause.length > 0);
}

// Matched terms that appear in this clause.
function termsInClause(clause: string, matchedTerms: string[]): string[] {
  const lower = clause.toLowerCase();
  return matchedTerms.filter((term) => containsTerm(lower, term));
}

/**
 * True when the clause reports that the misfire or code moved with / followed the component.
 * "Did not follow" is excluded here and handled as persistence instead.
 */
function isPositiveFollowFinding(clause: string, terms: string[]): boolean {
  if (/\bdid\s+not\s+follow\b/.test(clause)) {
    return false;
  }

  if (/\b(?:misfire|code|fault)\s+(?:followed|moved\s+with)\b/.test(clause)) {
    return terms.length > 0;
  }

  if (/\bmoved\s+the\s+(?:misfire|code|fault)\s+with\b/.test(clause)) {
    return terms.length > 0;
  }

  if (/\bfollowed\s+the\b/.test(clause) || /\bmoved\s+with\s+the\b/.test(clause)) {
    return terms.length > 0;
  }

  return false;
}

// True when a fault adjective sits near a matched system term in the clause.
function hasFaultAdjectiveNearTerm(clause: string, terms: string[]): boolean {
  if (!FAULT_ADJECTIVE_PATTERN.test(clause)) {
    return false;
  }

  for (const term of terms) {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nearFault = new RegExp(
      `(?:${FAULT_ADJECTIVE_PATTERN.source}\\s+(?:[a-z0-9]+\\s+){0,3}${escaped})|(?:${escaped}\\s+(?:[a-z0-9]+\\s+){0,3}${FAULT_ADJECTIVE_PATTERN.source})`
    );
    if (nearFault.test(clause)) {
      return true;
    }
  }

  return false;
}

// True when the clause reports low, weak, or absent compression for a compression term.
function isLowCompressionFinding(clause: string, terms: string[]): boolean {
  if (!hasCompressionTerm(terms)) {
    return false;
  }

  return (
    /\b(?:low|weak|no|poor)\s+compression\b/.test(clause) ||
    /\bcompression\s+(?:was\s+|is\s+)?(?:low|weak|poor)\b/.test(clause)
  );
}

// True when replacing/swapping the matched term resolved the fault.
function isResolvedAfterIntervention(clause: string, terms: string[]): boolean {
  if (!hasIntervention(clause) || terms.length === 0) {
    return false;
  }

  return /\b(?:fixed|resolved|cleared|gone|disappeared|no\s+longer\s+misfir)\b/.test(clause);
}

/**
 * Classify one clause against the matched terms for a single hypothesis.
 * Returns null when the clause only mentions the system without a polarity signal.
 */
function classifyPositiveClause(clause: string, terms: string[]): MentionPolarityResult | null {
  if (terms.length === 0) {
    return null;
  }

  if (isPositiveFollowFinding(clause, terms)) {
    return {
      polarity: "supports",
      reason: "fault followed or moved with a component of this system",
    };
  }

  if (isLowCompressionFinding(clause, terms)) {
    return {
      polarity: "supports",
      reason: "low or weak compression finding for this system",
    };
  }

  if (hasFaultAdjectiveNearTerm(clause, terms)) {
    return {
      polarity: "supports",
      reason: "finding reports a fault in a component of this system",
    };
  }

  if (isResolvedAfterIntervention(clause, terms)) {
    return {
      polarity: "supports",
      reason: "problem resolved after intervening on this system",
    };
  }

  return null;
}

/**
 * Classify how one evidence finding relates to a hypothesis it already mentions.
 * Uses only the finding text and the terms that linked the evidence to the hypothesis.
 * Defaults to context when the source discusses the system without a clear positive or negative finding.
 */
export function classifyMentionPolarity(
  text: string,
  matchedTerms: string[]
): MentionPolarityResult {
  const haystack = text.replace(/\s+/g, " ").trim().toLowerCase();

  if (matchedTerms.length === 0) {
    return { polarity: "context", reason: "no matched system terms" };
  }

  // Normal/equal compression weakens mechanical hypotheses whenever compression terms matched.
  if (hasNormalCompression(haystack) && hasCompressionTerm(matchedTerms)) {
    return {
      polarity: "contradicts",
      reason: "normal or equal compression finding for this system",
    };
  }

  const persistence = hasPersistence(haystack);
  const clauses = splitClauses(haystack);
  let support: MentionPolarityResult | null = null;

  for (const clause of clauses) {
    const terms = termsInClause(clause, matchedTerms);
    if (terms.length === 0) {
      continue;
    }

    // Term appears in a clause that records an intervention, and the finding says the fault remained.
    if (hasIntervention(clause) && persistence) {
      return {
        polarity: "contradicts",
        reason: "prior intervention or check on this system left the problem unchanged",
      };
    }

    const positive = classifyPositiveClause(clause, terms);
    if (positive !== null && support === null) {
      support = positive;
    }
  }

  if (support !== null) {
    return support;
  }

  return {
    polarity: "context",
    reason: "source discusses this system without a clear supporting or contradicting finding",
  };
}
