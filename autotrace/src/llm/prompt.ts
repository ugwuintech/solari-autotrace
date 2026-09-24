import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type { HypothesisBoard } from "../types/hypothesis.js";
import type { ReasoningRequest } from "../types/reasoning.js";

/**
 * The reasoning contract every provider imposes on the model.
 * These rules exist because the model is the only part of AutoTrace that can produce text it was
 * not given, so the prompt has to forbid recall, invention, and code-based diagnosis explicitly.
 * Validation still enforces the evidence rules afterwards: this is instruction, not a guarantee.
 */
const SYSTEM_PROMPT = [
  "You are the diagnostic reasoning stage of AutoTrace, an automotive diagnostic research assistant.",
  "Research has already been carried out for you. Your job is to judge competing diagnostic hypotheses against the evidence supplied below, and to recommend the next diagnostic test.",
  "",
  "Rules you must follow:",
  "1. Use only the evidence supplied in this message. You have no other sources and must not rely on recall.",
  "2. Never invent sources, URLs, facts, vehicle specifications, measurements, test results, or findings.",
  "3. Every supporting or contradicting evidence reference must be one of the supplied evidence items, quoted with its exact title and URL.",
  "4. If no supplied evidence supports or contradicts a hypothesis, return an empty list. Do not invent a reference to fill it.",
  "5. Distinguish evidence from inference. Say plainly when something is your inference rather than something a supplied source stated.",
  "6. If the evidence is insufficient to judge a hypothesis, say so and use the support value \"insufficient-evidence\".",
  "7. A diagnostic trouble code reports a condition detected by a vehicle system. It does not prove which component failed. Never diagnose from a code alone.",
  "8. Never recommend replacing a part because a code is present. Recommend inspection, measurement, and testing instead.",
  "9. Recommend a next test that would separate the competing hypotheses whenever the evidence permits one.",
  "10. The scanner code descriptions are case input reported by whoever supplied the case. Treat them as claims about the vehicle, not as independently verified facts.",
  "11. No hypothesis is a confirmed cause. Describe what the evidence shows, not what the fault is.",
  "12. Mentions are labelled with a polarity. Treat them as follows:",
  "    - context: the source discusses the system but does not establish whether it is faulty. Never put context mentions in supportingEvidence or contradictingEvidence.",
  "    - supports: the source reports a finding that actually supports the hypothesis. Only these may go in supportingEvidence.",
  "    - contradicts: the source reports a failed prior intervention, a negative diagnostic result, or a finding inconsistent with the hypothesis. Put these in contradictingEvidence, never in supportingEvidence.",
  "13. A source that merely names a component (coil, injector, wiring, and so on) is not supporting evidence for that hypothesis.",
  "14. Polarity labels are assigned deterministically by AutoTrace before you see them. Treat polarity=contradicts as contradictingEvidence for that hypothesis, and polarity=supports as supportingEvidence. Do not reclassify a contradicts or supports mention as mere context because the wording seems ambiguous to you.",
  "15. Reply with a single JSON object matching the required schema. No prose, no explanation outside the JSON, no markdown, no code fences.",
].join("\n");

// Short labels (E1, E2, ...) so the hypothesis board can point at evidence without repeating URLs.
function evidenceLabels(evidence: Evidence[]): Map<string, string> {
  return new Map(evidence.map((item, index) => [item.url, `E${index + 1}`]));
}

// The vehicle, codes, symptoms, and notes exactly as they were supplied with the case.
function formatCase(diagnosticCase: DiagnosticCase): string {
  const { vehicle, codes, symptoms, additionalInformation } = diagnosticCase;
  const lines: string[] = ["DIAGNOSTIC CASE (as reported, not independently verified)", ""];

  const vehicleParts = [
    `Make: ${vehicle.make}`,
    `Model: ${vehicle.model}`,
    vehicle.platform ? `Platform: ${vehicle.platform}` : null,
    vehicle.year ? `Year: ${vehicle.year}` : null,
    vehicle.engine ? `Engine: ${vehicle.engine}` : null,
  ].filter((part): part is string => part !== null);
  lines.push(`Vehicle: ${vehicleParts.join(", ")}`);

  lines.push("Scanner codes reported with the case:");
  for (const code of codes) {
    const description = code.description ? ` — ${code.description}` : "";
    const status = code.status ? ` (status: ${code.status})` : "";
    lines.push(`  - ${code.code}${description}${status}`);
  }

  lines.push(`Reported symptoms: ${symptoms && symptoms.length > 0 ? symptoms.join("; ") : "none supplied"}`);

  if (additionalInformation && additionalInformation.length > 0) {
    lines.push(`Additional information: ${additionalInformation.join("; ")}`);
  }

  return lines.join("\n");
}

// The competing hypotheses, with each mention labelled by polarity (context / supports / contradicts).
function formatHypotheses(board: HypothesisBoard, labels: Map<string, string>): string {
  const lines: string[] = [
    "COMPETING HYPOTHESES (possible causes under investigation, none confirmed)",
    "",
    "Each mention below includes a polarity assigned from the finding text:",
    "- context: discussed the system only; not support and not contradiction",
    "- supports: a finding that actually supports this hypothesis",
    "- contradicts: a failed intervention, negative test, or inconsistent finding for this hypothesis",
    "Do not place context or contradicts mentions in supportingEvidence.",
    "Do not place context mentions in contradictingEvidence. Mentions labelled polarity=contradicts must appear in contradictingEvidence for that hypothesis.",
    "",
  ];

  for (const entry of board.hypotheses) {
    const { hypothesis, mentions } = entry;
    lines.push(`${hypothesis.id} — ${hypothesis.label}`);
    lines.push(`  Claim: ${hypothesis.claim}`);
    lines.push(`  Possible causes: ${hypothesis.possibleCauses.join("; ")}`);

    if (mentions.length === 0) {
      lines.push("  Evidence mentioning this system: none");
    } else {
      const mentioned = mentions.map((mention) => {
        const label = labels.get(mention.evidence.url) ?? mention.evidence.url;
        return `${label} [polarity=${mention.polarity}; ${mention.polarityReason}] (matched terms: ${mention.matchedTerms.join(", ")})`;
      });
      lines.push(`  Evidence mentioning this system: ${mentioned.join("; ")}`);
    }

    lines.push("");
  }

  if (board.unmentionedEvidence.length > 0) {
    const unmentioned = board.unmentionedEvidence.map((item) => labels.get(item.url) ?? item.url);
    lines.push(`Evidence that mentioned no hypothesis system: ${unmentioned.join(", ")}`);
  }

  return lines.join("\n").trimEnd();
}

// The canonical evidence list. Anything the model references must come from here.
function formatEvidence(evidence: Evidence[], labels: Map<string, string>): string {
  const lines: string[] = ["EVIDENCE COLLECTED BY RESEARCH (the only sources you may reference)", ""];

  if (evidence.length === 0) {
    lines.push("No evidence was collected. Every hypothesis must therefore be reported as insufficient-evidence,");
    lines.push("and every evidence reference list must be empty.");
    return lines.join("\n");
  }

  for (const item of evidence) {
    const label = labels.get(item.url) ?? item.url;
    lines.push(`${label}`);
    lines.push(`  Title: ${item.title}`);
    lines.push(`  URL: ${item.url}`);
    lines.push(`  Finding: ${item.finding}`);
    lines.push(`  Relevance tag from extraction: ${item.relevance}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// The response shape, described in words alongside the schema the provider enforces.
function formatOutputContract(board: HypothesisBoard): string {
  const ids = board.hypotheses.map((entry) => entry.hypothesis.id);

  return [
    "REQUIRED OUTPUT",
    "",
    "Return one JSON object with exactly these fields:",
    `  hypothesisAssessments: one entry for every hypothesis (${ids.join(", ")}), each with:`,
    "    hypothesisId: the hypothesis identifier",
    "    support: one of \"strongly-supported\", \"moderately-supported\", \"weakly-supported\", \"contradicted\", \"insufficient-evidence\"",
    "    explanation: why the supplied evidence leads to that judgement, separating evidence from your inference",
    "    supportingEvidence: array of { title, url } from evidence items whose polarity for this hypothesis is supports, or []. Never include context or contradicts mentions.",
    "    contradictingEvidence: array of { title, url } from evidence items whose polarity for this hypothesis is contradicts, or []. Never include context or supports mentions.",
    "  conflicts: array of disagreements between supplied sources, each with description, references ({ title, url }), and affectedHypotheses. Use [] if the sources do not disagree.",
    "  unknowns: array of questions the supplied evidence cannot answer, each with question and whyItMatters.",
    "  recommendedNextTest: a single test with name, purpose, procedure (ordered steps), and distinguishes (the hypotheses its result would separate).",
    "  reasoning: a short summary of how you weighed the evidence, stating what remains unproven.",
  ].join("\n");
}

/**
 * Build the system and user messages for one reasoning request.
 * The user message carries the case, the hypothesis board, and the canonical evidence list, so the
 * model has everything AutoTrace knows and nothing it does not.
 */
export function buildReasoningPrompt(request: ReasoningRequest): { system: string; user: string } {
  const labels = evidenceLabels(request.evidence);

  const user = [
    formatCase(request.diagnosticCase),
    formatHypotheses(request.board, labels),
    formatEvidence(request.evidence, labels),
    formatOutputContract(request.board),
  ].join("\n\n");

  return { system: SYSTEM_PROMPT, user };
}
