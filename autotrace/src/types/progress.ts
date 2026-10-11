/** Pipeline stage a progress event belongs to, used by the UI to label the activity feed. */
export type ProgressStage =
  | "research"
  | "search"
  | "source"
  | "evidence"
  | "hypotheses"
  | "reasoning"
  | "follow-up"
  | "recovery"
  | "complete";

/**
 * One real step of a running investigation, reported when it happens.
 * Events describe work that actually occurred; nothing is emitted on a timer or simulated.
 */
export type ProgressEvent = {
  stage: ProgressStage;
  message: string;
  detail?: string;
  // Milliseconds since the Unix epoch when the step was reported.
  at: number;
};

export type ProgressListener = (event: ProgressEvent) => void;
