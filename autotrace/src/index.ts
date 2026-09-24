import {
  runInvestigation,
  type InvestigationResult,
} from "./agent/investigate.js";
import type { DiagnosticCase } from "./types/diagnosticCase.js";
import type { Evidence } from "./types/evidence.js";
import type { HypothesisBoard, HypothesisId } from "./types/hypothesis.js";
import type { InvestigationState } from "./types/investigation.js";
import type {
  DiagnosticAssessment,
  EvidenceReference,
  EvidenceSupport,
} from "./types/reasoning.js";
import type { ResearchObjective } from "./types/researchObjective.js";

const diagnosticCase: DiagnosticCase = {
  vehicle: {
    make: "Mercedes-Benz",
    model: "C240",
    platform: "W203",
  },
  codes: [
    { code: "P0305", description: "cylinder 5 misfire" },
    { code: "P2001", description: "EGR/air-management related fault" },
    { code: "P0400", description: "EGR/air-management related fault" },
  ],
  symptoms: ["misfire cylinder 5"],
};

const SUPPORT_LABELS: Record<EvidenceSupport, string> = {
  "strongly-supported": "Strongly supported",
  "moderately-supported": "Moderately supported",
  "weakly-supported": "Weakly supported",
  contradicted: "Contradicted",
  "insufficient-evidence": "Insufficient evidence",
};

// Show a hypothesis as its identifier and label, so the assessment stays tied to the board.
function formatHypothesis(board: HypothesisBoard, id: HypothesisId): string {
  const entry = board.hypotheses.find((item) => item.hypothesis.id === id);
  if (!entry) {
    return id;
  }
  return `${entry.hypothesis.id} — ${entry.hypothesis.label}`;
}

// Print sources cited by the assessment. Titles and URLs were resolved against collected evidence.
function printReferences(references: EvidenceReference[]) {
  if (references.length === 0) {
    console.log("     none");
    return;
  }

  for (const reference of references) {
    console.log(`     - ${reference.title}`);
    console.log(`       URL: ${reference.url}`);
  }
}

// Print the competing hypotheses and the evidence collected against each one.
function printHypothesisBoard(board: HypothesisBoard) {
  console.log("Competing hypotheses (possible causes, none confirmed):\n");

  for (const entry of board.hypotheses) {
    const { hypothesis, mentions } = entry;
    console.log(`${hypothesis.id} — ${hypothesis.label}`);
    console.log(`   Claim: ${hypothesis.claim}`);
    console.log(`   Possible causes: ${hypothesis.possibleCauses.join("; ")}`);

    if (mentions.length === 0) {
      console.log("   Evidence mentioning this system: none collected yet\n");
      continue;
    }

    console.log(`   Evidence mentioning this system: ${mentions.length}`);
    for (const mention of mentions) {
      console.log(`     - ${mention.evidence.title}`);
      console.log(`       URL: ${mention.evidence.url}`);
      console.log(`       Matched terms: ${mention.matchedTerms.join(", ")}`);
      console.log(`       Polarity: ${mention.polarity} (${mention.polarityReason})`);
    }
    console.log("");
  }

  if (board.unmentionedEvidence.length > 0) {
    console.log("Evidence that mentioned no hypothesis system:\n");
    for (const [index, item] of board.unmentionedEvidence.entries()) {
      console.log(`${index + 1}. ${item.title}`);
      console.log(`   URL: ${item.url}\n`);
    }
  }
}

// Print the collected evidence list for one investigation.
function printEvidence(evidence: Evidence[]) {
  console.log("Evidence:\n");

  if (evidence.length === 0) {
    console.log("No usable evidence could be extracted from the source pages.\n");
    return;
  }

  for (const [index, item] of evidence.entries()) {
    console.log(`${index + 1}. ${item.title}`);
    console.log(`   URL: ${item.url}`);
    console.log(`   Finding: ${item.finding}`);
    console.log(`   Relevance: ${item.relevance}\n`);
  }
}

// Print queries that research actually executed during the investigation.
function printAttemptedQueries(queries: string[]) {
  console.log("Queries executed:\n");
  if (queries.length === 0) {
    console.log("None recorded.\n");
    return;
  }

  for (const [index, query] of queries.entries()) {
    console.log(`${index + 1}. ${query}`);
  }
  console.log("");
}

// Print unresolved questions left after the latest assessment.
function printUnresolvedQuestions(questions: string[]) {
  console.log("Unresolved questions:\n");
  if (questions.length === 0) {
    console.log("None recorded.\n");
    return;
  }

  for (const [index, question] of questions.entries()) {
    console.log(`${index + 1}. ${question}`);
  }
  console.log("");
}

// Print follow-up research objectives when a second round was planned.
function printFollowUpObjectives(objectives: ResearchObjective[]) {
  if (objectives.length === 0) {
    return;
  }

  console.log("Follow-up research objectives:\n");
  for (const [index, objective] of objectives.entries()) {
    console.log(`${index + 1}. ${objective.id}`);
    console.log(`   Question: ${objective.question}`);
    console.log(`   Rationale: ${objective.rationale}`);
    if (objective.relatedHypotheses.length > 0) {
      console.log(`   Related hypotheses: ${objective.relatedHypotheses.join(", ")}`);
    }
    console.log("");
  }
}

// Print evidence newly discovered in the follow-up round, when any was found.
function printNewFollowUpEvidence(evidence: Evidence[]) {
  if (evidence.length === 0) {
    return;
  }

  console.log("Newly discovered evidence (round 2):\n");
  for (const [index, item] of evidence.entries()) {
    console.log(`${index + 1}. ${item.title}`);
    console.log(`   URL: ${item.url}`);
    console.log(`   Finding: ${item.finding}\n`);
  }
}

// Explain that reasoning was skipped because there is no collected evidence to assess.
function printSkippedAssessment() {
  console.log("Diagnostic assessment");
  console.log("=====================\n");
  console.log("No evidence was collected, so no diagnostic assessment was produced.");
  console.log("The language model was not called.");
  console.log("An assessment without collected sources would not be traceable to this research.");
  console.log("Physical inspection and diagnostic testing are still required before any repair decision.\n");
}

// Print the validated assessment as a research finding, separate from the sources above it.
function printDiagnosticAssessment(
  board: HypothesisBoard,
  assessment: DiagnosticAssessment,
  providerName: string
) {
  console.log("Diagnostic assessment");
  console.log("=====================\n");
  console.log("This is a research-based assessment of the evidence collected above.");
  console.log("It is not a confirmed diagnosis, and no hypothesis below is a proven cause.");
  console.log("Physical inspection and diagnostic testing are still required.\n");
  console.log(`Reasoning provider: ${providerName}\n`);

  console.log("Hypothesis assessments:\n");
  for (const item of assessment.hypothesisAssessments) {
    console.log(formatHypothesis(board, item.hypothesisId));
    console.log(`   Assessment: ${SUPPORT_LABELS[item.support]}`);
    console.log(`   Explanation: ${item.explanation}`);
    console.log("   Supporting evidence:");
    printReferences(item.supportingEvidence);
    console.log("   Contradicting evidence:");
    printReferences(item.contradictingEvidence);
    console.log("");
  }

  console.log("Conflicts:\n");
  if (assessment.conflicts.length === 0) {
    console.log("None recorded.\n");
  } else {
    for (const [index, conflict] of assessment.conflicts.entries()) {
      console.log(`${index + 1}. ${conflict.description}`);
      const affected = conflict.affectedHypotheses.map((id) => formatHypothesis(board, id));
      console.log(`   Affected hypotheses: ${affected.length > 0 ? affected.join("; ") : "none named"}`);
      console.log("   Sources:");
      printReferences(conflict.references);
      console.log("");
    }
  }

  console.log("Unknowns:\n");
  if (assessment.unknowns.length === 0) {
    console.log("None recorded.\n");
  } else {
    for (const [index, unknown] of assessment.unknowns.entries()) {
      console.log(`${index + 1}. ${unknown.question}`);
      console.log(`   Why it matters: ${unknown.whyItMatters}\n`);
    }
  }

  const nextTest = assessment.recommendedNextTest;
  console.log("Recommended next test:\n");
  console.log(nextTest.name);
  console.log(`   Purpose: ${nextTest.purpose}`);
  console.log("   Procedure:");
  for (const [index, step] of nextTest.procedure.entries()) {
    console.log(`     ${index + 1}. ${step}`);
  }
  const distinguished = nextTest.distinguishes.map((id) => formatHypothesis(board, id));
  console.log(
    `   Hypotheses this test may distinguish: ${distinguished.length > 0 ? distinguished.join("; ") : "none named"}`
  );
  console.log("");

  console.log("Reasoning summary:\n");
  console.log(assessment.reasoning);
  console.log("");
  console.log("Physical diagnostic testing is still required. This assessment does not confirm the fault.");
}

// Print investigation status and round count after the bounded loop finishes.
function printCompletion(state: InvestigationState) {
  console.log("\nInvestigation complete");
  console.log("======================\n");
  console.log(`Status: ${state.status}`);
  console.log(`Research rounds completed: ${state.researchRound}`);
  console.log(`Evidence collected: ${state.evidence.length}`);
  console.log(`Unresolved questions remaining: ${state.unresolvedQuestions.length}`);
}

// Print a full investigation result from the bounded orchestration loop.
function printInvestigation(result: InvestigationResult) {
  const { state } = result;

  console.log(`Research rounds: ${state.researchRound}\n`);
  printAttemptedQueries(state.attemptedQueries);
  printEvidence(state.evidence);
  printHypothesisBoard(state.hypothesisBoard);
  printFollowUpObjectives(result.followUpObjectives);
  printNewFollowUpEvidence(result.newEvidenceFromFollowUp);

  if (result.followUpFailures.length > 0) {
    console.log("Follow-up research failures:\n");
    for (const [index, failure] of result.followUpFailures.entries()) {
      console.log(`${index + 1}. ${failure.objective.id}`);
      console.log(`   Query: ${failure.query}`);
      console.log(`   Reason: ${failure.reason}\n`);
    }
  }

  if (!state.assessment) {
    printSkippedAssessment();
  } else {
    console.log("");
    printDiagnosticAssessment(state.hypothesisBoard, state.assessment, result.providerName);
    console.log("");
    printUnresolvedQuestions(state.unresolvedQuestions);
  }

  printCompletion(state);
}

/**
 * CLI entry point for the hardcoded Mercedes demonstration case.
 * The local tester UI (`npm run dev`) calls the same runInvestigation pipeline with form input.
 */
async function main() {
  console.log("AutoTrace Research Agent");
  console.log("========================\n");
  console.log("Running a bounded investigation (maximum of two research rounds).\n");
  console.log("Tip: use `npm run dev` for the local tester UI with arbitrary cases.\n");

  const result = await runInvestigation(diagnosticCase);
  printInvestigation(result);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`AutoTrace failed:\n${reason}`);
  process.exit(1);
});
