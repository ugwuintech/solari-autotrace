import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type { ResearchObjective } from "../types/researchObjective.js";

// Follow-up execution stays as small as the planner's objective budget.
export const MAX_FOLLOW_UP_OBJECTIVES = 3;

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
 * Build one focused search-engine query for a research objective.
 * Deterministic: preserves vehicle and DTC context; does not diagnose or invent browser instructions.
 */
export function buildFollowUpQuery(
  diagnosticCase: DiagnosticCase,
  objective: ResearchObjective
): string {
  const vehicle = formatVehicle(diagnosticCase.vehicle);
  const codes = diagnosticCase.codes
    .map((item) => item.code)
    .filter((code) => code.length > 0)
    .join(" ");
  const focus = extractObjectiveFocus(objective.question);
  return [vehicle, codes, focus]
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
