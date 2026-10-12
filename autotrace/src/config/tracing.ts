import { flush, init, shutdown } from "neatlogs";

// Neatlogs ingest endpoint. The project is selected by NEATLOGS_API_KEY; without it, export is disabled.
const NEATLOGS_ENDPOINT = "https://ingest.neatlogs.com";

/**
 * Start Neatlogs tracing once per process. The workflow name labels which entry point produced the
 * trace (CLI demo or UI API). The API key is read from NEATLOGS_API_KEY and never passed in code.
 */
export async function initTracing(workflowName: string): Promise<void> {
  await init({ workflowName, endpoint: NEATLOGS_ENDPOINT });
}

// Drain batched spans before a one-shot process exits; unflushed spans are otherwise lost.
export async function shutdownTracing(): Promise<void> {
  await flush();
  await shutdown();
}
