import { AsyncLocalStorage } from "node:async_hooks";
import type { ProgressListener, ProgressStage } from "../types/progress.js";

// One listener per running investigation. AsyncLocalStorage keeps concurrent requests apart without
// threading a callback through every research and browser function.
const listeners = new AsyncLocalStorage<ProgressListener>();

/** Run fn with listener receiving every progress event reported inside it. */
export function withProgress<T>(listener: ProgressListener, fn: () => Promise<T>): Promise<T> {
  return listeners.run(listener, fn);
}

/** Report a pipeline step to the current investigation's listener, if anyone is listening. */
export function reportProgress(stage: ProgressStage, message: string, detail?: string): void {
  const listener = listeners.getStore();
  if (!listener) {
    return;
  }

  try {
    listener(detail === undefined ? { stage, message, at: Date.now() } : { stage, message, detail, at: Date.now() });
  } catch (error) {
    // A broken listener (for example a closed HTTP response) must never break the investigation.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`AutoTrace progress listener failed: ${reason}`);
  }
}
