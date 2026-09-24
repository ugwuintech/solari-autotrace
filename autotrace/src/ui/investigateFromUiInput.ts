import {
  runInvestigation,
  type InvestigationDependencies,
  type InvestigationResult,
} from "../agent/investigate.js";
import type { InvestigationFormInput, InvestigationUiResult } from "../types/ui.js";
import { mapInvestigationResult } from "./mapInvestigationResult.js";
import {
  InvestigationInputError,
  parseInvestigationInput,
} from "./parseInvestigationInput.js";

/**
 * Dependencies for the UI investigation entry point.
 * Tests inject a fake runInvestigation; the live server uses the real pipeline.
 */
export type UiInvestigateDependencies = {
  runInvestigation?: (
    diagnosticCase: Parameters<typeof runInvestigation>[0],
    dependencies?: InvestigationDependencies
  ) => Promise<InvestigationResult>;
  investigationDependencies?: InvestigationDependencies;
};

/**
 * Parse tester form input, run the shared investigation pipeline, and map the result for the UI.
 * This is the single programmatic entry used by the HTTP server; it does not duplicate research logic.
 */
export async function investigateFromUiInput(
  input: InvestigationFormInput,
  dependencies: UiInvestigateDependencies = {}
): Promise<InvestigationUiResult> {
  const diagnosticCase = parseInvestigationInput(input);
  const run = dependencies.runInvestigation ?? runInvestigation;
  const result = await run(diagnosticCase, dependencies.investigationDependencies);
  return mapInvestigationResult(result);
}

// Re-export so the server and tests can distinguish validation failures from pipeline failures.
export { InvestigationInputError };
