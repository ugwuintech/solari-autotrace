import { createOllamaProvider } from "../llm/ollama.js";
import type { LlmProvider } from "../llm/provider.js";
import { buildHypothesisBoard } from "../reasoning/hypotheses.js";
import { planFollowUpResearch } from "../reasoning/planFollowUpResearch.js";
import {
  executeFollowUpResearch,
  type FollowUpResearchRunner,
} from "../research/executeFollowUpResearch.js";
import { collectNewEvidence } from "../research/followUpQuery.js";
import { research, type ResearchOptions, type ResearchResult } from "../research/research.js";
import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type {
  FollowUpResearchContext,
  FollowUpResearchFailure,
  FollowUpResearchResult,
} from "../types/followUpResearch.js";
import type { InvestigationState } from "../types/investigation.js";
import type { ResearchObjective } from "../types/researchObjective.js";

/**
 * Hard ceiling on research rounds for the investigation loop.
 * Round 1 is initial research; round 2 is optional follow-up; there is never a round 3.
 */
export const MAX_RESEARCH_ROUNDS = 2;

/**
 * Research runner used by the investigation orchestrator.
 * Defaults to the shared research() pipeline; injectable so unit tests never touch the network.
 */
export type InvestigationResearchRunner = (
  diagnosticCase: DiagnosticCase,
  options?: ResearchOptions
) => Promise<Pick<ResearchResult, "queries" | "evidence">>;

/**
 * Optional overrides for deterministic tests and alternate providers.
 * Defaults run the live Solari research pipeline and the local Ollama/Qwen provider.
 */
export type InvestigationDependencies = {
  research?: InvestigationResearchRunner;
  provider?: LlmProvider;
  planFollowUpResearch?: (state: InvestigationState) => ResearchObjective[];
  executeFollowUpResearch?: (
    diagnosticCase: DiagnosticCase,
    objectives: ResearchObjective[],
    context: FollowUpResearchContext,
    runResearch?: FollowUpResearchRunner
  ) => Promise<FollowUpResearchResult>;
};

/**
 * Final investigation outcome: the InvestigationState plus round-2 display metadata.
 * Metadata is omitted from InvestigationState so the state model stays the single source of truth
 * for evidence, assessment, and status; the CLI uses the extras only for progress reporting.
 */
export type InvestigationResult = {
  state: InvestigationState;
  followUpObjectives: ResearchObjective[];
  newEvidenceFromFollowUp: Evidence[];
  followUpFailures: FollowUpResearchFailure[];
  providerName: string;
  reasoningCalls: number;
};

// Start an empty investigation ready for the first research round.
function createInitialState(diagnosticCase: DiagnosticCase): InvestigationState {
  return {
    diagnosticCase,
    evidence: [],
    hypothesisBoard: buildHypothesisBoard([]),
    researchRound: 0,
    attemptedQueries: [],
    unresolvedQuestions: [],
    status: "researching",
  };
}

// Pull open questions from a validated assessment into the investigation queue.
function unresolvedFromAssessment(
  assessment: NonNullable<InvestigationState["assessment"]>
): string[] {
  return assessment.unknowns.map((item) => item.question);
}

// Append only queries that research actually executed; skip proposed-but-unused strings.
function recordExecutedQueries(
  attemptedQueries: string[],
  executed: string[]
): string[] {
  return [...attemptedQueries, ...executed];
}

// Merge round-2 evidence into the existing collection using URL-based deduplication.
function combineEvidence(existing: Evidence[], incoming: Evidence[]): Evidence[] {
  return [...existing, ...collectNewEvidence(incoming, existing)];
}

// Build a finished result that preserves the current state and optional follow-up metadata.
function finish(
  state: InvestigationState,
  extras: {
    followUpObjectives?: ResearchObjective[];
    newEvidenceFromFollowUp?: Evidence[];
    followUpFailures?: FollowUpResearchFailure[];
    providerName: string;
    reasoningCalls: number;
  }
): InvestigationResult {
  return {
    state: { ...state, status: "complete" },
    followUpObjectives: extras.followUpObjectives ?? [],
    newEvidenceFromFollowUp: extras.newEvidenceFromFollowUp ?? [],
    followUpFailures: extras.followUpFailures ?? [],
    providerName: extras.providerName,
    reasoningCalls: extras.reasoningCalls,
  };
}

/**
 * Run a bounded two-round diagnostic investigation.
 *
 * Round 1: initial research → hypothesis board → Qwen assessment.
 * Round 2 (only when unresolved questions remain): plan → follow-up research →
 * rebuild board from all evidence → Qwen assessment again → stop.
 *
 * There is no while-loop, recursion, or third research round. Remaining unknowns after
 * round 2 stay in the final state for the report.
 */
export async function runInvestigation(
  diagnosticCase: DiagnosticCase,
  dependencies: InvestigationDependencies = {}
): Promise<InvestigationResult> {
  const runResearch = dependencies.research ?? research;
  const provider = dependencies.provider ?? createOllamaProvider();
  const planFollowUp = dependencies.planFollowUpResearch ?? planFollowUpResearch;
  const executeFollowUp =
    dependencies.executeFollowUpResearch ?? executeFollowUpResearch;

  let state = createInitialState(diagnosticCase);
  let reasoningCalls = 0;

  // --- Round 1: initial research ---
  const round1 = await runResearch(diagnosticCase);
  state = {
    ...state,
    evidence: round1.evidence,
    attemptedQueries: recordExecutedQueries([], round1.queries),
    researchRound: 1,
    hypothesisBoard: buildHypothesisBoard(round1.evidence),
  };

  if (state.evidence.length === 0) {
    return finish(state, {
      providerName: provider.name,
      reasoningCalls,
    });
  }

  state = { ...state, status: "assessing" };
  const assessment1 = await provider.reason({
    diagnosticCase,
    board: state.hypothesisBoard,
    evidence: state.evidence,
  });
  reasoningCalls += 1;

  const unresolved1 = unresolvedFromAssessment(assessment1);
  state = {
    ...state,
    assessment: assessment1,
    unresolvedQuestions: unresolved1,
    status: unresolved1.length > 0 ? "needs-follow-up" : "complete",
  };

  // Stop after one round when there is nothing actionable to research next.
  if (unresolved1.length === 0) {
    return finish(state, {
      providerName: provider.name,
      reasoningCalls,
    });
  }

  // Hard boundary: never start a research round beyond MAX_RESEARCH_ROUNDS.
  if (state.researchRound >= MAX_RESEARCH_ROUNDS) {
    return finish(state, {
      providerName: provider.name,
      reasoningCalls,
    });
  }

  // --- Round 2: targeted follow-up ---
  const objectives = planFollowUp(state);
  if (objectives.length === 0) {
    return finish(state, {
      providerName: provider.name,
      reasoningCalls,
    });
  }

  const followUp = await executeFollowUp(
    diagnosticCase,
    objectives,
    {
      existingEvidence: state.evidence,
      attemptedQueries: state.attemptedQueries,
    },
    runResearch
  );

  const attemptedQueries = recordExecutedQueries(
    state.attemptedQueries,
    followUp.executedQueries
  );
  const combinedEvidence = combineEvidence(state.evidence, followUp.newEvidence);

  state = {
    ...state,
    evidence: combinedEvidence,
    attemptedQueries,
    researchRound: 2,
  };

  // No new evidence: keep the round-1 assessment and unresolved questions; do not call Qwen again.
  if (followUp.newEvidence.length === 0) {
    return finish(state, {
      followUpObjectives: objectives,
      newEvidenceFromFollowUp: [],
      followUpFailures: followUp.failures,
      providerName: provider.name,
      reasoningCalls,
    });
  }

  const board2 = buildHypothesisBoard(combinedEvidence);
  state = {
    ...state,
    hypothesisBoard: board2,
    status: "assessing",
  };

  const assessment2 = await provider.reason({
    diagnosticCase,
    board: board2,
    evidence: combinedEvidence,
  });
  reasoningCalls += 1;

  // Replace assessment and unresolved queue; stop even if unknowns remain.
  state = {
    ...state,
    assessment: assessment2,
    unresolvedQuestions: unresolvedFromAssessment(assessment2),
  };

  return finish(state, {
    followUpObjectives: objectives,
    newEvidenceFromFollowUp: followUp.newEvidence,
    followUpFailures: followUp.failures,
    providerName: provider.name,
    reasoningCalls,
  });
}
