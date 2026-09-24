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
  /\b(?:swapped|swapping|replaced|replacing|changed|changing|tested|checked|inspected|cleaned|ruled\s+out|moved|was\s+moved|were\s+moved)\b/;

// Phrases that say the fault remained after an intervention or check.
const PERSISTENCE_PATTERNS: RegExp[] = [
  /\bno\s+change\b/,
  /\bno\s+luck\b/,
  /\bstill\s+(?:(?:has|have|getting|seeing|showing)\s+)?(?:the\s+)?(?:p\d{4}|misfire|code|codes|problem|fault)\b/,
  /\b(?:misfire|problem|code|fault|p\d{4})\s+remains?\b/,
  /\b(?:misfire|problem|code|fault)\s+remained\b/,
  /\bdid\s+not\s+follow\b/,
  /\bmisfires?\s+did\s+not\s+follow\b/,
  /\bcontinued\s+(?:to\s+)?(?:misfire|misfiring)\b/,
  /\bdid\s+not\s+(?:resolve|clear|fix|go\s+away)\b/,
  /\bsame\s+(?:code|misfire|problem)\b/,
];

// Compression measured normal/equal — a negative finding for a mechanical hypothesis.
const NORMAL_COMPRESSION_PATTERNS: RegExp[] = [
  /\bcompression\s+(?:was\s+|is\s+|were\s+)?(?:equal|normal|good|fine|ok|okay|even|similar|consistent|within\s+spec)\b/,
  /\b(?:equal|normal|good|even|similar|consistent)\s+compression\b/,
];

// Numeric psi-style ranges such as "175-190" or "175 to 190".
const COMPRESSION_RANGE_PATTERN = /\b\d{2,3}\s*(?:[-–—/]|to)\s*\d{2,3}\b/;

// Phrases that say the reported values apply across cylinders.
const ALL_CYLINDERS_PATTERN =
  /\b(?:every|all|each)\s+cylinders?\b|\bacross\s+(?:all\s+)?(?:the\s+)?cylinders?\b/;

// Fault adjectives that, next to a matched system term, count as supporting findings.
const FAULT_ADJECTIVE_PATTERN =
  /\b(?:failed|bad|faulty|defective|dead|clogged|leaking|shorted|cracked|fouled|worn|broken|damaged)\b/;

// True when the haystack reports normal, equal, or evenly ranged compression across cylinders.
function hasNormalCompression(haystack: string): boolean {
  if (NORMAL_COMPRESSION_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return true;
  }

  // Numeric ranges such as "compression (175-190 every cylinder)" imply even results.
  return (
    /\bcompression\b/.test(haystack) &&
    COMPRESSION_RANGE_PATTERN.test(haystack) &&
    ALL_CYLINDERS_PATTERN.test(haystack)
  );
}

// True when the haystack records a diagnostic intervention on some component.
// Fault-relocation phrases such as "misfire moved from ..." are not component interventions.
function hasIntervention(haystack: string): boolean {
  const withoutFaultMoves = haystack
    .replace(/\b(?:misfire|code|fault)\s+moved\b/g, " ")
    .replace(/\bmoved\s+(?:the\s+)?(?:misfire|code|fault)\b/g, " ");
  return INTERVENTION_PATTERN.test(withoutFaultMoves);
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
  if (terms.length === 0) {
    return false;
  }

  if (/\bdid\s+not\s+follow\b/.test(clause) || /\bno\s+luck\b/.test(clause)) {
    return false;
  }

  if (/\b(?:misfire|code|fault)\s+(?:followed|moved\s+with)\b/.test(clause)) {
    return true;
  }

  // "misfire moved from cylinder 5 to cylinder 4 after swapping the coil"
  if (/\b(?:misfire|code|fault)\s+moved\s+from\b/.test(clause)) {
    return true;
  }

  if (/\bmoved\s+the\s+(?:misfire|code|fault)\s+with\b/.test(clause)) {
    return true;
  }

  if (/\bfollowed\s+the\b/.test(clause) || /\bmoved\s+with\s+the\b/.test(clause)) {
    return true;
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

// True when the clause reports low, weak, lower, or absent compression for a compression term.
function isLowCompressionFinding(clause: string, terms: string[]): boolean {
  if (!hasCompressionTerm(terms)) {
    return false;
  }

  return (
    /\b(?:low|weak|no|poor|lower)\s+compression\b/.test(clause) ||
    /\bcompression\s+(?:was\s+|is\s+)?(?:significantly\s+)?(?:low|weak|poor|lower)\b/.test(clause)
  );
}

/**
 * True when the clause reports a low/restricted flow or pressure finding, or a value below spec,
 * for a matched system term (e.g. injector flow was low, EGR flow below specification).
 */
function isAbnormalMeasurementFinding(clause: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }

  if (/\b(?:flow|pressure)\s+(?:was\s+|is\s+)?(?:low|restricted|weak|poor)\b/.test(clause)) {
    return true;
  }

  if (/\b(?:low|restricted|weak|poor)\s+(?:injector\s+|fuel\s+|egr\s+)?(?:flow|pressure)\b/.test(clause)) {
    return true;
  }

  if (/\b(?:was\s+|is\s+)?below\s+(?:specification|spec)\b/.test(clause)) {
    return true;
  }

  return false;
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

  if (isAbnormalMeasurementFinding(clause, terms)) {
    return {
      polarity: "supports",
      reason: "abnormal measurement or below-spec finding for this system",
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

    const positive = classifyPositiveClause(clause, terms);

    // A clear follow/move finding supports the hypothesis even when an intervention verb is present.
    if (positive !== null && positive.reason.startsWith("fault followed")) {
      return positive;
    }

    // Term appears in a clause that records an intervention, and the finding says the fault remained.
    if (hasIntervention(clause) && persistence) {
      return {
        polarity: "contradicts",
        reason: "prior intervention or check on this system left the problem unchanged",
      };
    }

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
