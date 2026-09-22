import type { Evidence } from "../types/evidence.js";
import type { HypothesisId } from "../types/hypothesis.js";
import type {
  DiagnosticAssessment,
  DiagnosticUnknown,
  EvidenceConflict,
  EvidenceReference,
  EvidenceSupport,
  HypothesisAssessment,
  ReasoningRequest,
  RecommendedTest,
} from "../types/reasoning.js";

const SUPPORT_VALUES: readonly EvidenceSupport[] = [
  "strongly-supported",
  "moderately-supported",
  "weakly-supported",
  "contradicted",
  "insufficient-evidence",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every failure names the field that failed so an invalid response can be diagnosed from the error.
function invalid(path: string, problem: string): Error {
  return new Error(`model response field "${path}" ${problem}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalid(path, `is missing or is not an object (received ${describe(value)})`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(path, `is missing or is not an array (received ${describe(value)})`);
  }
  return value;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(path, `is missing or is not a non-empty string (received ${describe(value)})`);
  }
  return value.trim();
}

// A short, safe description of an unexpected value for use in error messages.
function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "string") {
    return `"${value.slice(0, 60)}"`;
  }
  return typeof value;
}

function requireSupport(value: unknown, path: string): EvidenceSupport {
  const text = requireText(value, path);
  const support = SUPPORT_VALUES.find((candidate) => candidate === text);
  if (!support) {
    throw invalid(path, `is "${text}", which is not one of: ${SUPPORT_VALUES.join(", ")}`);
  }
  return support;
}

// Hypothesis identifiers are resolved against the board, so an assessment cannot name a hypothesis
// that was never under investigation.
function requireHypothesisId(value: unknown, knownIds: Map<string, HypothesisId>, path: string): HypothesisId {
  const text = requireText(value, path);
  const id = knownIds.get(text);
  if (!id) {
    throw invalid(path, `is "${text}", which is not one of the hypotheses supplied: ${[...knownIds.keys()].join(", ")}`);
  }
  return id;
}

/**
 * Resolve one evidence reference against the evidence actually supplied with the request.
 * Matching is by URL, and the title is then taken from the evidence store rather than from the
 * model, so a reference can neither point at an invented source nor restate a source inaccurately.
 */
function requireEvidenceReference(
  value: unknown,
  evidenceByUrl: Map<string, Evidence>,
  path: string
): EvidenceReference {
  const record = requireRecord(value, path);
  const url = requireText(record.url, `${path}.url`);
  const evidence = evidenceByUrl.get(url);

  if (!evidence) {
    throw invalid(
      `${path}.url`,
      `cites "${url}", which is not one of the ${evidenceByUrl.size} evidence item(s) supplied`
    );
  }

  return { title: evidence.title, url: evidence.url };
}

function requireEvidenceReferences(
  value: unknown,
  evidenceByUrl: Map<string, Evidence>,
  path: string
): EvidenceReference[] {
  return requireArray(value, path).map((item, index) =>
    requireEvidenceReference(item, evidenceByUrl, `${path}[${index}]`)
  );
}

function requireHypothesisAssessment(
  value: unknown,
  knownIds: Map<string, HypothesisId>,
  evidenceByUrl: Map<string, Evidence>,
  path: string
): HypothesisAssessment {
  const record = requireRecord(value, path);

  return {
    hypothesisId: requireHypothesisId(record.hypothesisId, knownIds, `${path}.hypothesisId`),
    support: requireSupport(record.support, `${path}.support`),
    explanation: requireText(record.explanation, `${path}.explanation`),
    supportingEvidence: requireEvidenceReferences(
      record.supportingEvidence,
      evidenceByUrl,
      `${path}.supportingEvidence`
    ),
    contradictingEvidence: requireEvidenceReferences(
      record.contradictingEvidence,
      evidenceByUrl,
      `${path}.contradictingEvidence`
    ),
  };
}

// Every hypothesis on the board must be judged exactly once: a silently dropped hypothesis would
// look like a hypothesis that was considered and found irrelevant.
function requireCompleteCoverage(assessments: HypothesisAssessment[], knownIds: Map<string, HypothesisId>): void {
  const assessed = new Set<string>(assessments.map((assessment) => assessment.hypothesisId));

  if (assessed.size !== assessments.length) {
    throw invalid("hypothesisAssessments", "assesses the same hypothesis more than once");
  }

  const missing = [...knownIds.keys()].filter((id) => !assessed.has(id));
  if (missing.length > 0) {
    throw invalid("hypothesisAssessments", `does not assess every hypothesis (missing: ${missing.join(", ")})`);
  }
}

function requireConflict(
  value: unknown,
  knownIds: Map<string, HypothesisId>,
  evidenceByUrl: Map<string, Evidence>,
  path: string
): EvidenceConflict {
  const record = requireRecord(value, path);

  return {
    description: requireText(record.description, `${path}.description`),
    references: requireEvidenceReferences(record.references, evidenceByUrl, `${path}.references`),
    affectedHypotheses: requireArray(record.affectedHypotheses, `${path}.affectedHypotheses`).map((item, index) =>
      requireHypothesisId(item, knownIds, `${path}.affectedHypotheses[${index}]`)
    ),
  };
}

function requireUnknown(value: unknown, path: string): DiagnosticUnknown {
  const record = requireRecord(value, path);

  return {
    question: requireText(record.question, `${path}.question`),
    whyItMatters: requireText(record.whyItMatters, `${path}.whyItMatters`),
  };
}

function requireRecommendedTest(
  value: unknown,
  knownIds: Map<string, HypothesisId>,
  path: string
): RecommendedTest {
  const record = requireRecord(value, path);
  const procedure = requireArray(record.procedure, `${path}.procedure`).map((step, index) =>
    requireText(step, `${path}.procedure[${index}]`)
  );

  if (procedure.length === 0) {
    throw invalid(`${path}.procedure`, "contains no steps, so no test was actually recommended");
  }

  return {
    name: requireText(record.name, `${path}.name`),
    purpose: requireText(record.purpose, `${path}.purpose`),
    procedure,
    distinguishes: requireArray(record.distinguishes, `${path}.distinguishes`).map((item, index) =>
      requireHypothesisId(item, knownIds, `${path}.distinguishes[${index}]`)
    ),
  };
}

/**
 * Recover the JSON object from the raw model output.
 * Models sometimes wrap JSON in a code fence or emit a reasoning block before it, so the object is
 * located rather than assumed. A thinking block may arrive without its opening tag, so everything
 * up to the last closing tag is discarded. Nothing inside the object is altered.
 */
function extractJsonObject(text: string): string {
  const thinkingEnd = text.lastIndexOf("</think>");
  const withoutThinking = thinkingEnd >= 0 ? text.slice(thinkingEnd + "</think>".length) : text;
  const start = withoutThinking.indexOf("{");
  const end = withoutThinking.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error(`model response contained no JSON object (received: ${withoutThinking.trim().slice(0, 200)})`);
  }

  return withoutThinking.slice(start, end + 1);
}

/**
 * Turn raw model output into a DiagnosticAssessment, or throw explaining why it is not one.
 * Validation is performed against the request the model was given: hypothesis identifiers must
 * belong to the board and every evidence citation must resolve to evidence research actually
 * collected, so the model cannot introduce a hypothesis, a source, or a URL of its own.
 */
export function parseAssessment(text: string, request: ReasoningRequest): DiagnosticAssessment {
  let payload: unknown;
  try {
    payload = JSON.parse(extractJsonObject(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`model response was not valid JSON: ${reason}`);
  }

  const knownIds = new Map<string, HypothesisId>(
    request.board.hypotheses.map((entry) => [entry.hypothesis.id, entry.hypothesis.id])
  );
  const evidenceByUrl = new Map<string, Evidence>(request.evidence.map((item) => [item.url, item]));

  const root = requireRecord(payload, "response");
  const hypothesisAssessments = requireArray(root.hypothesisAssessments, "hypothesisAssessments").map(
    (item, index) =>
      requireHypothesisAssessment(item, knownIds, evidenceByUrl, `hypothesisAssessments[${index}]`)
  );
  requireCompleteCoverage(hypothesisAssessments, knownIds);

  return {
    hypothesisAssessments,
    conflicts: requireArray(root.conflicts, "conflicts").map((item, index) =>
      requireConflict(item, knownIds, evidenceByUrl, `conflicts[${index}]`)
    ),
    unknowns: requireArray(root.unknowns, "unknowns").map((item, index) =>
      requireUnknown(item, `unknowns[${index}]`)
    ),
    recommendedNextTest: requireRecommendedTest(root.recommendedNextTest, knownIds, "recommendedNextTest"),
    reasoning: requireText(root.reasoning, "reasoning"),
  };
}
