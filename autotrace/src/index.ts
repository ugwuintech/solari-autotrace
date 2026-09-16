import { buildHypothesisBoard } from "./reasoning/hypotheses.js";
import { research, type ResearchResult } from "./research/research.js";
import type { DiagnosticCase } from "./types/diagnosticCase.js";
import type { HypothesisBoard } from "./types/hypothesis.js";

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

// Run the Mercedes demonstration case and print sources, extracted evidence, and the hypothesis board.
async function main() {
  console.log("AutoTrace Research Agent");
  console.log("========================\n");

  const result = await research(diagnosticCase);
  printReport(result);

  console.log("");
  printHypothesisBoard(buildHypothesisBoard(result.evidence));
}

main().catch((error) => {
  console.error("AutoTrace failed:", error);
  process.exit(1);
});
