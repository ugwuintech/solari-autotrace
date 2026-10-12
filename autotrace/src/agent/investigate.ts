import { span } from "neatlogs";
import { createProviderFromEnv } from "../llm/selectProvider.js";
import { reportProgress } from "../observability/progress.js";
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
import type { HypothesisBoard } from "../types/hypothesis.js";
import type { InvestigationState } from "../types/investigation.js";
import type { DiagnosticAssessment } from "../types/reasoning.js";
import type { RecoveryEvent, RecoveryRecorder } from "../types/recovery.js";
import type { SearchBlock } from "../types/search.js";
import type { ResearchObjective } from "../types/researchObjective.js";

/**
 * Hard ceiling on research rounds for the investigation loop.
 * Round 1 is initial research; round 2 is optional follow-up; there is never a round 3.
 */
export const MAX_RESEARCH_ROUNDS = 2;

// Each live Solari research run appears as a tool call in the Neatlogs trace.
const tracedResearch = span({ kind: "TOOL", toolName: "web_research" }, research);
// Rule-based evidence polarity and the follow-up decision, so the trace shows why round 2 ran.
const tracedHypothesisBoard = span(
  { kind: "CHAIN", name: "evaluate_evidence", captureInput: false },
  buildHypothesisBoard
);
const tracedPlanFollowUp = span(
  { kind: "AGENT", name: "plan_follow_up", captureInput: false },
  planFollowUpResearch
);

/**
 * Research runner used by the investigation orchestrator.
 * Defaults to the shared research() pipeline; injectable so unit tests never touch the network.
 */
export type InvestigationResearchRunner = (
  diagnosticCase: DiagnosticCase,
  options?: ResearchOptions
) => Promise<
  Pick<ResearchResult, "queries" | "evidence"> & Partial<Pick<ResearchResult, "recoveries" | "searchBlocks">>
>;

/**
 * Optional overrides for deterministic tests and alternate providers.
 * Defaults run the live Solari research pipeline and the provider chosen by AUTOTRACE_LLM (Ollama/Qwen unless set).
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
  /** Present when round-2 reassessment failed; round-1 assessment and board are retained. */
  reassessmentError?: string;
  /** Failed actions the agent recovered from, in the order they happened. */
  recoveries: RecoveryEvent[];
  /** Searches that were stopped (block or repeated navigation failure) and not worked around. */
  searchBlocks: SearchBlock[];
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

// Report the rebuilt hypothesis board as polarity totals, so the feed shows what the evidence says.
function reportBoard(board: HypothesisBoard, evidenceCount: number): void {
  const mentions = board.hypotheses.flatMap((entry) => entry.mentions);
  const count = (polarity: string) => mentions.filter((mention) => mention.polarity === polarity).length;
  reportProgress(
    "hypotheses",
    `Hypothesis board updated from ${evidenceCount} evidence item(s)`,
    `${count("supports")} supporting, ${count("contradicts")} contradicting, ${count("context")} context mention(s)`
  );
}

function reportReasoningStart(providerName: string, board: HypothesisBoard, evidenceCount: number): void {
  reportProgress(
    "reasoning",
    `Asking ${providerName} to weigh ${board.hypotheses.length} hypotheses against ${evidenceCount} evidence item(s)`
  );
}

// Report a validated assessment as each hypothesis's qualitative support label.
function reportAssessment(assessment: DiagnosticAssessment): void {
  reportProgress(
    "reasoning",
    `Assessment validated against the collected evidence; ${assessment.unknowns.length} open question(s)`,
    assessment.hypothesisAssessments.map((item) => `${item.hypothesisId}: ${item.support}`).join(", ")
  );
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
    reassessmentError?: string;
  }
): Omit<InvestigationResult, "recoveries" | "searchBlocks"> {
  return {
    state: { ...state, status: "complete" },
    followUpObjectives: extras.followUpObjectives ?? [],
    newEvidenceFromFollowUp: extras.newEvidenceFromFollowUp ?? [],
    followUpFailures: extras.followUpFailures ?? [],
    providerName: extras.providerName,
    reasoningCalls: extras.reasoningCalls,
    ...(extras.reassessmentError !== undefined
      ? { reassessmentError: extras.reassessmentError }
      : {}),
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
  const recoveries: RecoveryEvent[] = [];
  const searchBlocks: SearchBlock[] = [];
  const result = await runBoundedInvestigation(diagnosticCase, dependencies, searchBlocks, (event) => {
    console.log(`Recovered from a failed ${event.step} step: ${event.action}\n`);
    reportProgress("recovery", `Recovered a failed ${event.step} step: ${event.action}`, event.failure);
    recoveries.push(event);
  });
  reportProgress(
    "complete",
    `Investigation complete: ${result.state.evidence.length} evidence item(s) over ${result.state.researchRound} round(s)`
  );
  return { ...result, recoveries, searchBlocks };
}

async function runBoundedInvestigation(
  diagnosticCase: DiagnosticCase,
  dependencies: InvestigationDependencies,
  searchBlocks: SearchBlock[],
  recordRecovery: RecoveryRecorder
): Promise<Omit<InvestigationResult, "recoveries" | "searchBlocks">> {
  const baseResearch = dependencies.research ?? tracedResearch;
  // Every research round (initial and follow-up) reports its recoveries to the investigation.
  const runResearch: InvestigationResearchRunner = async (researchCase, options) => {
    const outcome = await baseResearch(researchCase, options);
    for (const event of outcome.recoveries ?? []) {
      recordRecovery(event);
    }
    searchBlocks.push(...(outcome.searchBlocks ?? []));
    return outcome;
  };
  const provider = dependencies.provider ?? createProviderFromEnv(process.env, { onRecovery: recordRecovery });
  const planFollowUp = dependencies.planFollowUpResearch ?? tracedPlanFollowUp;
  const executeFollowUp =
    dependencies.executeFollowUpResearch ?? executeFollowUpResearch;

  let state = createInitialState(diagnosticCase);
  let reasoningCalls = 0;

  // --- Round 1: initial research ---
  reportProgress("research", "Round 1: researching the case");
  const round1 = await runResearch(diagnosticCase);
  state = {
    ...state,
    evidence: round1.evidence,
    attemptedQueries: recordExecutedQueries([], round1.queries),
    researchRound: 1,
    hypothesisBoard: tracedHypothesisBoard(round1.evidence),
  };
  reportBoard(state.hypothesisBoard, state.evidence.length);

  if (state.evidence.length === 0) {
    reportProgress("research", "No evidence was collected, so the model assessment is skipped");
    return finish(state, {
      providerName: provider.name,
      reasoningCalls,
    });
  }

  state = { ...state, status: "assessing" };
  reportReasoningStart(provider.name, state.hypothesisBoard, state.evidence.length);
  const assessment1 = await provider.reason({
    diagnosticCase,
    board: state.hypothesisBoard,
    evidence: state.evidence,
  });
  reasoningCalls += 1;
  reportAssessment(assessment1);

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

  reportProgress(
    "follow-up",
    `Round 2: researching ${objectives.length} open question(s)`,
    objectives.map((objective) => objective.question).join("\n")
  );
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

  reportProgress("follow-up", `Follow-up research found ${followUp.newEvidence.length} new evidence item(s)`);

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

  const board1 = state.hypothesisBoard;
  const board2 = tracedHypothesisBoard(combinedEvidence);
  state = {
    ...state,
    hypothesisBoard: board2,
    status: "assessing",
  };
  reportBoard(board2, combinedEvidence.length);

  try {
    reportReasoningStart(provider.name, board2, combinedEvidence.length);
    const assessment2 = await provider.reason({
      diagnosticCase,
      board: board2,
      evidence: combinedEvidence,
    });
    reasoningCalls += 1;
    reportAssessment(assessment2);

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
  } catch (error: unknown) {
    // Round-2 reassessment failed: keep the successful round-1 assessment and board.
    const reason = error instanceof Error ? error.message : String(error);
    reportProgress("reasoning", "Reassessment failed, so the round-1 assessment is kept", reason);
    state = {
      ...state,
      hypothesisBoard: board1,
      assessment: assessment1,
      unresolvedQuestions: unresolved1,
    };

    return finish(state, {
      followUpObjectives: objectives,
      newEvidenceFromFollowUp: followUp.newEvidence,
      followUpFailures: followUp.failures,
      providerName: provider.name,
      reasoningCalls,
      reassessmentError: reason,
    });
  }
}
