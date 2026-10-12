/**
 * One failed action and what AutoTrace did about it.
 * Recorded so the trace, the CLI report and the UI can show that the investigation recovered rather
 * than silently succeeding, and so a reviewer can see exactly which fallback produced the result.
 */
export type RecoveryEvent = {
  // Pipeline step that failed, e.g. "reasoning" or "source extraction".
  step: string;
  // What went wrong, in enough detail to diagnose it.
  failure: string;
  // What the agent did next.
  action: string;
};

export type RecoveryRecorder = (event: RecoveryEvent) => void;
