import { createOllamaProvider } from "./llm/ollama.js";
import { buildHypothesisBoard } from "./reasoning/hypotheses.js";
import { research, type ResearchResult } from "./research/research.js";
import type { DiagnosticCase } from "./types/diagnosticCase.js";
import type { HypothesisBoard, HypothesisId } from "./types/hypothesis.js";
import type {
  DiagnosticAssessment,
  EvidenceReference,
  EvidenceSupport,
  ReasoningRequest,
} from "./types/reasoning.js";

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

// Print queries, pipeline counts, visited sources, and extracted evidence.
function printReport(result: ResearchResult) {
  console.log("Queries executed:\n");
  for (const [index, query] of result.queries.entries()) {
    console.log(`${index + 1}. ${query}`);
  }

  if (result.searchBlocks.length > 0) {
    console.log("\nSearch engine blocks:\n");
    for (const block of result.searchBlocks) {
      console.log(`Query: ${block.query}`);
      console.log(`Reason: ${block.reason}`);
      console.log(`Page title: ${block.pageTitle}`);
      console.log(`Page URL: ${block.pageUrl}`);
    }
  }

  console.log(`\nSearch engine: ${result.searchEngine}`);
  console.log(`Raw search results: ${result.rawResultCount}`);
  console.log(`Unique candidates: ${result.uniqueCandidateCount}`);
  console.log(`Ranked candidates: ${result.rankedCandidateCount}`);
  console.log(`Candidates visited: ${result.candidatesVisited}`);
  console.log(`Candidates rejected as irrelevant: ${result.candidatesRejectedAsIrrelevant}`);
  console.log(`Evidence objects: ${result.evidence.length}\n`);

  if (result.rankedCandidates.length > 0) {
    console.log("Top ranked candidates:\n");
    for (const [index, candidate] of result.rankedCandidates.entries()) {
      console.log(`${index + 1}. [score ${candidate.score}] ${candidate.result.title}`);
      console.log(`   URL: ${candidate.result.url}`);
      console.log(`   Signals: ${candidate.signals.join(", ")}\n`);
    }
  }

  if (result.visitedCandidates.length > 0) {
    console.log("Visited candidates:\n");
    for (const [index, candidate] of result.visitedCandidates.entries()) {
      console.log(`${index + 1}. ${candidate.title}`);
      console.log(`   URL: ${candidate.url}\n`);
    }
  } else if (result.uniqueCandidateCount > 0) {
    console.log("No technically relevant candidates ranked high enough to visit.\n");
    console.log("Unique candidates excluded before visit:\n");
    for (const [index, evaluation] of result.candidateEvaluations.entries()) {
      console.log(`${index + 1}. ${evaluation.result.title}`);
      console.log(`   URL: ${evaluation.result.url}`);
      if (evaluation.exclusionReason) {
        console.log(`   Reason: ${evaluation.exclusionReason}\n`);
      } else {
        console.log("");
      }
    }
  }

  if (result.rejections.length > 0) {
    console.log("Visited sources that produced no evidence:\n");
    for (const [index, rejection] of result.rejections.entries()) {
      console.log(`${index + 1}. ${rejection.title}`);
      console.log(`   URL: ${rejection.url}`);
      console.log(`   Reason: ${rejection.reason}\n`);
    }
  }

  console.log("Evidence:\n");

  if (result.evidence.length === 0) {
    console.log("No usable evidence could be extracted from the source pages.");
    return;
  }

  for (const [index, item] of result.evidence.entries()) {
    console.log(`${index + 1}. ${item.title}`);
    console.log(`   URL: ${item.url}`);
    console.log(`   Finding: ${item.finding}`);
    console.log(`   Relevance: ${item.relevance}\n`);
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

    console.log(`   Evidence mentioning this system: ${mentions.length} (not yet evaluated as support)`);
    for (const mention of mentions) {
      console.log(`     - ${mention.evidence.title}`);
      console.log(`       URL: ${mention.evidence.url}`);
      console.log(`       Matched terms: ${mention.matchedTerms.join(", ")}`);
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

// Research the Mercedes demonstration case, then assess the collected evidence.
async function main() {
  console.log("AutoTrace Research Agent");
  console.log("========================\n");

  const result = await research(diagnosticCase);
  printReport(result);

  console.log("");
  const board = buildHypothesisBoard(result.evidence);
  printHypothesisBoard(board);

  if (result.evidence.length === 0) {
    console.log("");
    printSkippedAssessment();
    return;
  }

  const request: ReasoningRequest = {
    diagnosticCase,
    board,
    evidence: result.evidence,
  };

  const provider = createOllamaProvider();
  console.log("");
  console.log(`Requesting a diagnostic assessment from ${provider.name}.`);
  console.log("The model receives only this case, the hypothesis board, and the evidence printed above.");
  console.log("A local model may take several minutes.\n");

  const assessment = await provider.reason(request);
  printDiagnosticAssessment(board, assessment, provider.name);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`AutoTrace failed:\n${reason}`);
  process.exit(1);
});
