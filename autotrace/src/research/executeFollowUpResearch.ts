import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type {
  FollowUpResearchContext,
  FollowUpResearchFailure,
  FollowUpResearchResult,
} from "../types/followUpResearch.js";
import type { ResearchObjective } from "../types/researchObjective.js";
import {
  collectNewEvidence,
  planFollowUpQueries,
} from "./followUpQuery.js";
import { research, type ResearchOptions, type ResearchResult } from "./research.js";

/**
 * Research runner used by follow-up execution.
 * Defaults to the shared research() pipeline; injectable so unit tests never touch the network.
 */
export type FollowUpResearchRunner = (
  diagnosticCase: DiagnosticCase,
  options?: ResearchOptions
) => Promise<Pick<ResearchResult, "queries" | "evidence">>;

/**
 * Execute bounded ResearchObjective items through the existing research pipeline.
 * Does not invent objectives, call the LLM, or recurse into planFollowUpResearch().
 */
export async function executeFollowUpResearch(
  diagnosticCase: DiagnosticCase,
  objectives: ResearchObjective[],
  context: FollowUpResearchContext,
  runResearch: FollowUpResearchRunner = research
): Promise<FollowUpResearchResult> {
  const planned = planFollowUpQueries(
    diagnosticCase,
    objectives,
    context.attemptedQueries
  );

  if (planned.executable.length === 0) {
    return {
      attemptedObjectives: planned.attemptedObjectives,
      executedQueries: [],
      skippedQueries: planned.skippedQueries,
      newEvidence: [],
      failures: [],
    };
  }

  const executedQueries = planned.executable.map((item) => item.query);
  const failures: FollowUpResearchFailure[] = [];

  let collectedEvidence: Evidence[] = [];

  try {
    const outcome = await runResearch(diagnosticCase, {
      queries: executedQueries,
    });
    collectedEvidence = outcome.evidence;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const item of planned.executable) {
      failures.push({
        objective: item.objective,
        query: item.query,
        reason,
      });
    }

    return {
      attemptedObjectives: planned.attemptedObjectives,
      executedQueries,
      skippedQueries: planned.skippedQueries,
      newEvidence: [],
      failures,
    };
  }

  const newEvidence = collectNewEvidence(
    collectedEvidence,
    context.existingEvidence
  );

  return {
    attemptedObjectives: planned.attemptedObjectives,
    executedQueries,
    skippedQueries: planned.skippedQueries,
    newEvidence,
    failures,
  };
}
