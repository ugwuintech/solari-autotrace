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

// Resolution words used after an intervention.
const RESOLUTION_PATTERN =
  /\b(?:fixed|resolved|cleared|gone|disappeared|no\s+longer\s+misfir)\b/;

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

// True when any matched term is a compression or leak-down measurement term (not generic "leak").
function hasCompressionTerm(matchedTerms: string[]): boolean {
  return matchedTerms.some((term) => {
    const lower = term.toLowerCase();
    return (
      /\bcompression\b/.test(lower) ||
      /\bleak[\s-]?down\b/.test(lower) ||
      lower === "leakdown" ||
      lower === "leak-down" ||
      lower === "leak down"
    );
  });
}

// Collect cylinder numbers mentioned in a span of text.
function extractCylinderNumbers(text: string): number[] {
  const found = new Set<number>();
  const pattern = /\b(?:cylinders?|cyl\.?)\s*#?\s*(\d{1,2})(?:\s*(?:[-–—,/]|to|and|&)\s*(\d{1,2}))?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const first = Number(match[1]);
    if (Number.isFinite(first)) {
      found.add(first);
    }
    if (match[2]) {
      const second = Number(match[2]);
      if (Number.isFinite(second)) {
        // Inclusive range when written as "cylinders 1-3".
        if (/\d\s*(?:[-–—]|to)\s*\d/.test(match[0]) && second >= first) {
          for (let cylinder = first; cylinder <= second; cylinder += 1) {
            found.add(cylinder);
          }
        } else {
          found.add(second);
        }
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

// True when the span describes compression across all / every cylinder (broad scope).
function hasBroadCylinderScope(text: string): boolean {
  return ALL_CYLINDERS_PATTERN.test(text);
}

/**
 * True when a normal-compression statement and a low-compression statement refer to distinct
 * cylinder scopes, so the normal reading must not erase the scoped low finding.
 */
function compressionScopesAreDistinct(haystack: string): boolean {
  const lowMatch =
    haystack.match(
      /[^.!?;]*\b(?:(?:low|weak|no|poor|lower)\s+compression|compression\s+(?:was\s+|is\s+)?(?:significantly\s+)?(?:low|weak|poor|lower))[^.!?;]*/i
    ) ?? null;
  if (!lowMatch) {
    return false;
  }

  const lowSpan = lowMatch[0] ?? "";
  const lowCylinders = extractCylinderNumbers(lowSpan);
  if (lowCylinders.length === 0) {
    // Unscoped low compression is not a distinct-scope conflict with normal readings.
    return false;
  }

  const normalMatch =
    haystack.match(
      /[^.!?;]*\b(?:compression\s+(?:was\s+|is\s+|were\s+)?(?:equal|normal|good|fine|ok|okay|even|similar|consistent|within\s+spec)|(?:equal|normal|good|even|similar|consistent)\s+compression)[^.!?;]*/i
    ) ??
    (COMPRESSION_RANGE_PATTERN.test(haystack) && ALL_CYLINDERS_PATTERN.test(haystack)
      ? haystack.match(/[^.!?;]*\bcompression\b[^.!?;]*/i)
      : null);

  if (!normalMatch) {
    return false;
  }

  const normalSpan = normalMatch[0] ?? "";
  if (hasBroadCylinderScope(normalSpan) || extractCylinderNumbers(normalSpan).length === 0) {
    // Broad or unscoped normal must not erase a scoped low-compression finding.
    return true;
  }

  const normalCylinders = extractCylinderNumbers(normalSpan);
  return !lowCylinders.some((cylinder) => normalCylinders.includes(cylinder));
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
 * True when a short window before matchIndex contains local negation (not / no / n't),
 * excluding the intentional positive phrase "no longer".
 */
function hasLocalNegation(clause: string, matchIndex: number): boolean {
  if (matchIndex <= 0) {
    return false;
  }

  const windowStart = Math.max(0, matchIndex - 24);
  const before = clause.slice(windowStart, matchIndex);
  if (/\bno\s+longer\s+$/i.test(before)) {
    return false;
  }

  return /(?:\b(?:not|no|never)\b|n['’]t)\s*$/i.test(before.trimEnd());
}

// Component words captured after "followed" / "moved with" style phrases.
function componentAfterFollowPhrase(clause: string): string | null {
  const patterns = [
    /\b(?:misfire|code|fault)\s+followed\s+(?:the\s+)?([a-z0-9][a-z0-9\s-]{0,40}?)(?:\s+to\b|[.,;!]|$)/i,
    /\b(?:misfire|code|fault)\s+moved\s+with\s+(?:the\s+)?([a-z0-9][a-z0-9\s-]{0,40}?)(?:\s+to\b|[.,;!]|$)/i,
    /\bmoved\s+the\s+(?:misfire|code|fault)\s+with\s+(?:the\s+)?([a-z0-9][a-z0-9\s-]{0,40}?)(?:\s+to\b|[.,;!]|$)/i,
    /\bfollowed\s+the\s+([a-z0-9][a-z0-9\s-]{0,40}?)(?:\s+to\b|[.,;!]|$)/i,
    /\bmoved\s+with\s+the\s+([a-z0-9][a-z0-9\s-]{0,40}?)(?:\s+to\b|[.,;!]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = clause.match(pattern);
    if (match?.[1]) {
      return match[1].trim().toLowerCase();
    }
  }

  return null;
}

// True when the named follow/move component matches one of the hypothesis terms.
function followComponentMatchesTerms(component: string, terms: string[]): boolean {
  return terms.some((term) => {
    const lower = term.toLowerCase();
    return (
      containsTerm(component, lower) ||
      containsTerm(lower, component) ||
      component === lower ||
      component.includes(lower) ||
      lower.includes(component)
    );
  });
}

/**
 * True when the clause reports that the misfire or code moved with / followed the component.
 * "Did not follow" is excluded here and handled as persistence instead.
 * For followed / moved-with phrases, the named component must match a hypothesis term.
 */
function isPositiveFollowFinding(clause: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }

  if (/\bdid\s+not\s+follow\b/.test(clause) || /\bno\s+luck\b/.test(clause)) {
    return false;
  }

  const followComponent = componentAfterFollowPhrase(clause);
  if (followComponent !== null) {
    return followComponentMatchesTerms(followComponent, terms);
  }

  // "misfire moved from cylinder 5 to cylinder 4 after swapping the coil"
  if (/\b(?:misfire|code|fault)\s+moved\s+from\b/.test(clause)) {
    return true;
  }

  return false;
}

// True when a fault adjective sits near a matched system term and is not locally negated.
function hasFaultAdjectiveNearTerm(clause: string, terms: string[]): boolean {
  if (!FAULT_ADJECTIVE_PATTERN.test(clause)) {
    return false;
  }

  for (const term of terms) {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nearFault = new RegExp(
      `(?:${FAULT_ADJECTIVE_PATTERN.source}\\s+(?:[a-z0-9]+\\s+){0,3}${escaped})|(?:${escaped}\\s+(?:[a-z0-9]+\\s+){0,3}${FAULT_ADJECTIVE_PATTERN.source})`,
      "i"
    );
    const match = nearFault.exec(clause);
    if (!match || match.index === undefined) {
      continue;
    }

    const adjectiveMatch = FAULT_ADJECTIVE_PATTERN.exec(match[0].toLowerCase());
    const adjectiveOffset = adjectiveMatch?.index ?? 0;
    if (hasLocalNegation(clause, match.index + adjectiveOffset)) {
      continue;
    }

    return true;
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

// True when replacing/swapping the matched term resolved the fault (without local negation).
function isResolvedAfterIntervention(clause: string, terms: string[]): boolean {
  if (!hasIntervention(clause) || terms.length === 0) {
    return false;
  }

  const match = RESOLUTION_PATTERN.exec(clause);
  if (!match || match.index === undefined) {
    return false;
  }

  if (hasLocalNegation(clause, match.index)) {
    return false;
  }

  return true;
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

  // Normal/equal compression weakens mechanical hypotheses when scopes are not distinct from a low finding.
  if (
    hasNormalCompression(haystack) &&
    hasCompressionTerm(matchedTerms) &&
    !compressionScopesAreDistinct(haystack)
  ) {
    return {
      polarity: "contradicts",
      reason: "normal or equal compression finding for this system",
    };
  }

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

    // Persistence applies only when it appears in the same clause as this intervention.
    if (hasIntervention(clause) && hasPersistence(clause)) {
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
