import type { Evidence } from "./evidence.js";
import type { ResearchObjective } from "./researchObjective.js";

/**
 * One objective that the follow-up research runner could not complete.
 * Kept structured so the caller can see failure without treating the round as fully successful.
 */
export type FollowUpResearchFailure = {
  objective: ResearchObjective;
  query: string;
  reason: string;
};

/**
 * Result of executing bounded ResearchObjective items through the existing research pipeline.
 * Preserves enough detail for a later step to update InvestigationState without re-running research.
 */
export type FollowUpResearchResult = {
  attemptedObjectives: ResearchObjective[];
  executedQueries: string[];
  skippedQueries: string[];
  newEvidence: Evidence[];
  failures: FollowUpResearchFailure[];
};

/**
 * Prior-round context used to avoid repeating the same queries and evidence URLs.
 */
export type FollowUpResearchContext = {
  existingEvidence: Evidence[];
  attemptedQueries: string[];
};
