import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInvestigation } from "../src/agent/investigate.js";
import type { LlmProvider } from "../src/llm/provider.js";
import { reportProgress, withProgress } from "../src/observability/progress.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { ProgressEvent } from "../src/types/progress.js";
import type { DiagnosticAssessment } from "../src/types/reasoning.js";

const diagnosticCase: DiagnosticCase = {
  vehicle: { make: "Mercedes-Benz", model: "C240", platform: "W203" },
  codes: [{ code: "P0305", description: "Cylinder 5 misfire" }],
};

// A complete assessment with no open questions, so the investigation stops after round 1.
const finalAssessment: DiagnosticAssessment = {
  hypothesisAssessments: [],
  conflicts: [],
  unknowns: [],
  recommendedNextTest: {
    name: "Swap the cylinder 5 coil",
    purpose: "See whether the misfire follows the coil.",
    procedure: ["Swap the coil with another cylinder."],
    distinguishes: ["H1"],
  },
  reasoning: "Fixture assessment.",
};

const provider: LlmProvider = {
  name: "fixture-provider",
  async reason() {
    return finalAssessment;
  },
};

describe("progress reporting", () => {
  it("delivers events to the listener of the surrounding run only", async () => {
    const first: string[] = [];
    const second: string[] = [];

    await Promise.all([
      withProgress(
        (event) => first.push(event.message),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          reportProgress("search", "first run");
        }
      ),
      withProgress(
        (event) => second.push(event.message),
        async () => {
          reportProgress("search", "second run");
        }
      ),
    ]);

    assert.deepEqual(first, ["first run"]);
    assert.deepEqual(second, ["second run"]);
  });

  it("does nothing when no one is listening", () => {
    assert.doesNotThrow(() => reportProgress("search", "unobserved"));
  });

  it("never lets a failing listener break the investigation", async () => {
    const result = await withProgress(
      () => {
        throw new Error("response already closed");
      },
      async () => {
        reportProgress("search", "still fine");
        return "finished";
      }
    );

    assert.equal(result, "finished");
  });

  it("reports the real steps of an investigation in order", async () => {
    const events: ProgressEvent[] = [];

    await withProgress(
      (event) => events.push(event),
      () =>
        runInvestigation(diagnosticCase, {
          research: async () => ({
            queries: ["q"],
            evidence: [
              { title: "Coil swap", url: "https://example.test/a", finding: "Swap test.", relevance: "supports" },
            ],
          }),
          provider,
        })
    );

    assert.deepEqual(
      events.map((event) => event.stage),
      ["research", "hypotheses", "reasoning", "reasoning", "complete"]
    );
    assert.match(events[2]?.message ?? "", /fixture-provider/);
  });
});
