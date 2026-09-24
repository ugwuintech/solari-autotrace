import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvestigationResult } from "../src/agent/investigate.js";
import { buildHypothesisBoard } from "../src/reasoning/hypotheses.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { Evidence } from "../src/types/evidence.js";
import type { DiagnosticAssessment } from "../src/types/reasoning.js";
import {
  InvestigationInputError,
  investigateFromUiInput,
} from "../src/ui/investigateFromUiInput.js";
import {
  DIAGNOSTIC_DISCLAIMER,
  mapInvestigationResult,
} from "../src/ui/mapInvestigationResult.js";

const diagnosticCase: DiagnosticCase = {
  vehicle: {
    make: "Mercedes-Benz",
    model: "C240",
    platform: "W203",
  },
  codes: [{ code: "P0305" }, { code: "P2001" }, { code: "P0400" }],
  symptoms: ["Cylinder 5 misfire."],
};

// Build a minimal evidence fixture for UI mapping tests.
function sampleEvidence(): Evidence {
  return {
    title: "Coil swap left misfire on cylinder 5",
    url: "https://example.com/coil-swap",
    finding:
      "After swapping the ignition coil from cylinder 5 to cylinder 1, the misfire remained on cylinder 5.",
    relevance: "context",
  };
}

// Build a complete assessment fixture with contradicted ignition support.
function sampleAssessment(): DiagnosticAssessment {
  return {
    hypothesisAssessments: [
      {
        hypothesisId: "H1",
        support: "contradicted",
        explanation: "Ignition swap evidence contradicts a coil-only cause.",
        supportingEvidence: [],
        contradictingEvidence: [
          {
            title: "Coil swap left misfire on cylinder 5",
            url: "https://example.com/coil-swap",
          },
        ],
      },
      {
        hypothesisId: "H2",
        support: "insufficient-evidence",
        explanation: "Fuel delivery remains untested.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H3",
        support: "insufficient-evidence",
        explanation: "Mechanical causes remain untested.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H4",
        support: "weakly-supported",
        explanation: "Air-management codes were discussed.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H5",
        support: "insufficient-evidence",
        explanation: "Wiring was not discussed.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
    ],
    conflicts: [],
    unknowns: [
      {
        question: "Why does the ECM shut off the fuel injector driver for the remainder of the key cycle?",
        whyItMatters: "It changes how injector electrical tests should be interpreted.",
      },
    ],
    recommendedNextTest: {
      name: "Relative compression / mechanical contribution check",
      purpose: "Separate mechanical contribution from fuel/electrical causes on cylinder 5.",
      procedure: ["Warm the engine", "Measure relative compression on all cylinders"],
      distinguishes: ["H3", "H2"],
    },
    reasoning: "Ignition-only explanations are weakened by the swap outcome.",
  };
}

// Build a finished investigation result fixture for mapper and UI-entry tests.
function sampleInvestigationResult(): InvestigationResult {
  const evidence = [sampleEvidence()];
  const board = buildHypothesisBoard(evidence);
  const assessment = sampleAssessment();

  return {
    state: {
      diagnosticCase,
      evidence,
      hypothesisBoard: board,
      assessment,
      researchRound: 2,
      attemptedQueries: ["Mercedes-Benz C240 W203 P0305"],
      unresolvedQuestions: [
        "Why does the ECM shut off the fuel injector driver for the remainder of the key cycle?",
      ],
      status: "complete",
    },
    followUpObjectives: [],
    newEvidenceFromFollowUp: [],
    followUpFailures: [],
    providerName: "ollama-qwen3-4b",
    reasoningCalls: 2,
  };
}

describe("mapInvestigationResult", () => {
  it("exposes hypothesis assessment status and evidence polarity for the UI", () => {
    const uiResult = mapInvestigationResult(sampleInvestigationResult());

    assert.equal(uiResult.summary.researchRounds, 2);
    assert.equal(uiResult.summary.evidenceCount, 1);
    assert.equal(uiResult.summary.unresolvedQuestionCount, 1);
    assert.equal(uiResult.summary.reasoningProvider, "ollama-qwen3-4b");
    assert.equal(uiResult.disclaimer, DIAGNOSTIC_DISCLAIMER);

    const ignition = uiResult.hypotheses.find((item) => item.id === "H1");
    assert.ok(ignition);
    assert.equal(ignition.support, "contradicted");
    assert.equal(ignition.supportLabel, "Contradicted");
    assert.equal(ignition.contradictingEvidence.length, 1);
    assert.equal(ignition.contradictingEvidence[0]?.url, "https://example.com/coil-swap");

    assert.equal(uiResult.evidence[0]?.relevance, "context");
    assert.equal(uiResult.evidence[0]?.url, "https://example.com/coil-swap");
    assert.equal(uiResult.unknowns[0]?.question.includes("ECM shut off"), true);
    assert.equal(uiResult.recommendedNextTest?.name.includes("Relative compression"), true);
    assert.equal(uiResult.reasoning?.includes("Ignition-only"), true);
  });
});

describe("investigateFromUiInput", () => {
  it("passes a parsed DiagnosticCase into the shared investigation function", async () => {
    let receivedCase: DiagnosticCase | undefined;

    const uiResult = await investigateFromUiInput(
      {
        vehicle: "Mercedes-Benz C240 W203",
        codes: "P0305, P2001, P0400",
        symptoms: "Cylinder 5 misfire.",
      },
      {
        runInvestigation: async (parsedCase) => {
          receivedCase = parsedCase;
          return sampleInvestigationResult();
        },
      }
    );

    assert.deepEqual(receivedCase, {
      vehicle: {
        make: "Mercedes-Benz",
        model: "C240",
        platform: "W203",
      },
      codes: [{ code: "P0305" }, { code: "P2001" }, { code: "P0400" }],
      symptoms: ["Cylinder 5 misfire."],
    });
    assert.equal(uiResult.hypotheses[0]?.support, "contradicted");
    assert.equal(uiResult.evidence[0]?.relevance, "context");
  });

  it("rejects empty required fields before calling the investigation pipeline", async () => {
    let called = false;

    await assert.rejects(
      () =>
        investigateFromUiInput(
          {
            vehicle: "",
            codes: "P0305",
            symptoms: "",
          },
          {
            runInvestigation: async () => {
              called = true;
              return sampleInvestigationResult();
            },
          }
        ),
      (error: unknown) => error instanceof InvestigationInputError
    );

    assert.equal(called, false);
  });

  it("surfaces investigation failures from the shared pipeline", async () => {
    await assert.rejects(
      () =>
        investigateFromUiInput(
          {
            vehicle: "BMW E46 325i",
            codes: "P0300",
            symptoms: "Rough idle",
          },
          {
            runInvestigation: async () => {
              throw new Error("Ollama is not reachable");
            },
          }
        ),
      (error: unknown) =>
        error instanceof Error && error.message === "Ollama is not reachable"
    );
  });
});
