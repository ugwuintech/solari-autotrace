import type { DiagnosticCase, DiagnosticCode } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type { ResearchObjective } from "../types/researchObjective.js";

// Follow-up execution stays as small as the planner's objective budget.
export const MAX_FOLLOW_UP_OBJECTIVES = 3;

// Cap technical focus tokens so follow-up queries stay search-engine friendly.
const MAX_FOCUS_TERMS = 6;

// Cap selected DTCs so Round 2 does not restate every case code by default.
const MAX_RELEVANT_CODES = 2;

// Natural-language and boilerplate words that must not become search tokens.
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "address",
  "about",
  "been",
  "by",
  "can",
  "competing",
  "complex",
  "component",
  "contributing",
  "could",
  "documented",
  "does",
  "due",
  "especially",
  "evidence",
  "explanations",
  "explanation",
  "failure",
  "faulty",
  "find",
  "for",
  "from",
  "has",
  "have",
  "helps",
  "how",
  "in",
  "into",
  "is",
  "issue",
  "issues",
  "it",
  "its",
  "more",
  "of",
  "on",
  "or",
  "performed",
  "present",
  "problem",
  "problems",
  "question",
  "regarding",
  "related",
  "relevant",
  "specific",
  "system",
  "than",
  "that",
  "the",
  "there",
  "these",
  "this",
  "to",
  "unresolved",
  "was",
  "were",
  "what",
  "when",
  "whether",
  "which",
  "why",
  "with",
  "without",
]);

// Multi-word technical phrases extracted before single-token splitting.
const COMPOUND_TERMS = [
  "spark plug",
  "ignition coil",
  "air-management",
  "air management",
  "fuel delivery",
  "fuel pressure",
  "coil swap",
  "freeze frame",
  "freeze-frame",
  "valve seat",
];

// Orientation words already useful as search concepts; do not duplicate them.
const ORIENTATION_WORDS = new Set([
  "diagnostic",
  "test",
  "testing",
  "symptoms",
  "causes",
  "troubleshooting",
  "procedure",
  "technical",
]);

/**
 * Collapse whitespace and case so previously attempted queries can be compared reliably.
 */
export function normalizeResearchQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

// Prefer chassis/platform when present so follow-up queries stay vehicle-specific.
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

/**
 * Pull the topical focus from an objective question without inventing new research goals.
 * Prefers the unresolved-question tail when present; otherwise the "relevant to …" core.
 */
export function extractObjectiveFocus(question: string): string {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const addressMatch = normalized.match(
    /helps address(?: the unresolved diagnostic question)?:\s*(.+)$/i
  );
  if (addressMatch?.[1] !== undefined) {
    const focus = addressMatch[1].replace(/\s+/g, " ").trim();
    if (focus.length > 0) {
      return focus;
    }
  }

  const relevantMatch = normalized.match(
    /relevant to (.+?)(?: on the |, especially)/i
  );
  if (relevantMatch?.[1] !== undefined) {
    const focus = relevantMatch[1]
      .replace(/\bthese competing explanations\b/gi, " ")
      .replace(/\bexplanations?\b/gi, " ")
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (focus.length > 0) {
      return focus;
    }
  }

  return normalized
    .replace(/^Find technical evidence (?:relevant to|for the)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the hypothesis-label portion from an objective question when the planner linked one.
 */
function extractHypothesisLabelFocus(question: string): string {
  const relevantMatch = question.match(
    /relevant to (.+?)(?: on the |, especially)/i
  );
  if (relevantMatch?.[1] === undefined) {
    return "";
  }

  return relevantMatch[1]
    .replace(/\bthese competing explanations\b/gi, " ")
    .replace(/\bexplanations?\b/gi, " ")
    .replace(/\bof\b(?:\s+p[0-9]{4}\b,?)+/gi, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when the token is a DTC already handled by code selection.
function isDiagnosticCodeToken(token: string): boolean {
  return /^p[0-9]{4}$/i.test(token);
}

// Record a focus term once; compounds replace overlapping single tokens.
function addFocusTerm(terms: string[], candidate: string): void {
  const cleaned = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!cleaned) {
    return;
  }

  if (STOP_WORDS.has(cleaned) || ORIENTATION_WORDS.has(cleaned)) {
    return;
  }
  if (isDiagnosticCodeToken(cleaned)) {
    return;
  }
  if (cleaned.length < 3) {
    return;
  }
  if (terms.some((term) => term === cleaned)) {
    return;
  }

  const isCompound = cleaned.includes(" ") || cleaned.includes("-");
  if (isCompound) {
    const parts = cleaned.split(/[\s-]+/).filter((part) => part.length > 0);
    for (let index = terms.length - 1; index >= 0; index -= 1) {
      if (parts.includes(terms[index]!)) {
        terms.splice(index, 1);
      }
    }
  } else if (
    terms.some((term) => term.split(/[\s-]+/).includes(cleaned))
  ) {
    return;
  }

  terms.push(cleaned);
}

/**
 * Extract compact technical search concepts from objective wording.
 * Does not copy the full natural-language unresolved question into the query.
 */
export function extractTechnicalFocusTerms(objective: ResearchObjective): string[] {
  const sources = [
    extractHypothesisLabelFocus(objective.question),
    extractObjectiveFocus(objective.question),
  ].filter((part) => part.length > 0);

  const terms: string[] = [];

  for (const source of sources) {
    let remaining = source;

    for (const compound of COMPOUND_TERMS) {
      const pattern = new RegExp(
        compound.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "ig"
      );
      remaining = remaining.replace(pattern, (match) => {
        const normalized =
          match.toLowerCase() === "air management" ? "air-management" : match.toLowerCase();
        addFocusTerm(terms, normalized);
        return " ";
      });
    }

    const tokens = remaining
      .replace(/[?/!,.;:()]+/g, " ")
      .split(/[\s_/|-]+/)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0);

    for (const token of tokens) {
      addFocusTerm(terms, token);
    }
  }

  return terms.slice(0, MAX_FOCUS_TERMS);
}

// True when the haystack contains any of the candidate tokens as whole terms.
function haystackHasAny(haystack: string, candidates: string[]): boolean {
  return candidates.some((candidate) => {
    const token = candidate.toLowerCase();
    if (token.includes("-") || token.includes(" ")) {
      return haystack.includes(token);
    }
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack);
  });
}

/**
 * Score a DTC against follow-up focus terms using its description and common code families.
 */
function scoreCodeForFocus(code: DiagnosticCode, focusHaystack: string): number {
  let score = 0;
  const description = (code.description ?? "").toLowerCase();
  const codeLower = code.code.toLowerCase();

  for (const term of focusHaystack.split(/\s+/)) {
    if (!term) {
      continue;
    }
    if (description.includes(term) || term.includes(codeLower)) {
      score += 2;
    }
  }

  if (/^p030\d$/i.test(code.code)) {
    if (
      haystackHasAny(focusHaystack, [
        "misfire",
        "ignition",
        "coil",
        "spark",
        "plug",
        "spark plug",
        "ignition coil",
        "fuel",
        "injector",
        "compression",
        "mechanical",
        "cylinder",
        "wiring",
        "electrical",
      ])
    ) {
      score += 2;
    }
  }

  if (/^p040\d$/i.test(code.code) || /^p200\d$/i.test(code.code)) {
    if (
      haystackHasAny(focusHaystack, [
        "egr",
        "air-management",
        "air",
        "vacuum",
        "intake",
      ])
    ) {
      score += 3;
    }
  }

  return score;
}

/**
 * Choose the DTCs most relevant to the follow-up focus instead of dumping every case code.
 */
export function selectRelevantCodes(
  diagnosticCase: DiagnosticCase,
  focusTerms: string[]
): string[] {
  const codes = diagnosticCase.codes.filter((item) => item.code.length > 0);
  if (codes.length === 0) {
    return [];
  }
  if (codes.length === 1) {
    return [codes[0]!.code];
  }

  const focusHaystack = focusTerms.join(" ").toLowerCase();
  const scored = codes
    .map((item) => ({
      code: item.code,
      score: scoreCodeForFocus(item, focusHaystack),
    }))
    .sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));

  const positive = scored.filter((item) => item.score > 0);
  if (positive.length > 0) {
    return positive.slice(0, MAX_RELEVANT_CODES).map((item) => item.code);
  }

  // Fallback keeps vehicle-specific DTC context without restating the full code list.
  return [codes[0]!.code];
}

/**
 * Choose a small diagnostic-orientation suffix when the focus does not already supply one.
 */
export function selectOrientationTerms(focusTerms: string[]): string[] {
  const existing = new Set(focusTerms.map((term) => term.toLowerCase()));
  const orientation: string[] = [];

  if (
    !existing.has("diagnostic") &&
    !existing.has("troubleshooting") &&
    !existing.has("technical")
  ) {
    orientation.push("diagnostic");
  }

  if (
    !existing.has("test") &&
    !existing.has("testing") &&
    !existing.has("procedure")
  ) {
    orientation.push("test");
  }

  return orientation;
}

/**
 * Build one focused search-engine query for a research objective.
 * Deterministic: preserves vehicle and relevant DTC context; uses compact technical terms
 * instead of stuffing the natural-language unresolved question.
 */
export function buildFollowUpQuery(
  diagnosticCase: DiagnosticCase,
  objective: ResearchObjective
): string {
  const vehicle = formatVehicle(diagnosticCase.vehicle);
  const focusTerms = extractTechnicalFocusTerms(objective);
  const codes = selectRelevantCodes(diagnosticCase, focusTerms);
  const orientation = selectOrientationTerms(focusTerms);

  return [vehicle, ...codes, ...focusTerms, ...orientation]
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Select up to MAX_FOLLOW_UP_OBJECTIVES objectives and drop those whose query was already attempted.
 */
export function planFollowUpQueries(
  diagnosticCase: DiagnosticCase,
  objectives: ResearchObjective[],
  attemptedQueries: string[]
): {
  attemptedObjectives: ResearchObjective[];
  executable: Array<{ objective: ResearchObjective; query: string }>;
  skippedQueries: string[];
} {
  const attempted = new Set(
    attemptedQueries
      .map((query) => normalizeResearchQuery(query))
      .filter((query) => query.length > 0)
  );
  const seenThisRound = new Set<string>();
  const attemptedObjectives: ResearchObjective[] = [];
  const executable: Array<{ objective: ResearchObjective; query: string }> = [];
  const skippedQueries: string[] = [];

  for (const objective of objectives.slice(0, MAX_FOLLOW_UP_OBJECTIVES)) {
    attemptedObjectives.push(objective);
    const query = buildFollowUpQuery(diagnosticCase, objective);
    const normalized = normalizeResearchQuery(query);

    if (!normalized) {
      skippedQueries.push(query);
      continue;
    }

    if (attempted.has(normalized) || seenThisRound.has(normalized)) {
      skippedQueries.push(query);
      continue;
    }

    seenThisRound.add(normalized);
    executable.push({ objective, query });
  }

  return { attemptedObjectives, executable, skippedQueries };
}

/**
 * Keep evidence whose URL is not already present in the existing collection.
 * Order of first appearance is preserved; URLs are compared case-insensitively.
 */
export function collectNewEvidence(
  collected: Evidence[],
  existingEvidence: Evidence[]
): Evidence[] {
  const seen = new Set(
    existingEvidence
      .map((item) => item.url.replace(/\s+/g, "").trim().toLowerCase())
      .filter((url) => url.length > 0)
  );
  const fresh: Evidence[] = [];

  for (const item of collected) {
    const key = item.url.replace(/\s+/g, "").trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    fresh.push(item);
  }

  return fresh;
}
