import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planFollowUpResearch } from "../src/reasoning/planFollowUpResearch.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { HypothesisBoard } from "../src/types/hypothesis.js";
import type { InvestigationState } from "../src/types/investigation.js";
import type { DiagnosticAssessment } from "../src/types/reasoning.js";

const diagnosticCase: DiagnosticCase = {
  vehicle: {
    make: "Mercedes-Benz",
    model: "C240",
    platform: "W203",
  },
  codes: [
    { code: "P0305", description: "cylinder 5 misfire" },
    { code: "P2001", description: "EGR/air-management related fault" },
    { code: "P0400", description: "EGR/air-management related fault" },
  ],
  symptoms: ["misfire cylinder 5"],
};

// A board with the competing explanation families the planner may relate to by wording only.
function sampleBoard(): HypothesisBoard {
  return {
    hypotheses: [
      {
        hypothesis: {
          id: "H1",
          label: "Ignition-related misfire",
          claim: "A fault in the ignition path of the affected cylinder could produce the reported misfire.",
          possibleCauses: [
            "failed or intermittent ignition coil",
            "worn, fouled, or cracked spark plug",
          ],
        },
        mentions: [],
      },
      {
        hypothesis: {
          id: "H2",
          label: "Fuel delivery problem",
          claim: "Insufficient fuel delivery to the affected cylinder could produce the reported misfire.",
          possibleCauses: [
            "clogged, leaking, or electrically failed injector",
            "low or uneven fuel pressure",
          ],
        },
        mentions: [],
      },
      {
        hypothesis: {
          id: "H3",
          label: "Mechanical/compression problem",
          claim: "A mechanical defect in the affected cylinder could prevent normal combustion.",
          possibleCauses: [
            "low compression in the affected cylinder",
            "valve, valve seat, or valve seal damage",
          ],
        },
        mentions: [],
      },
      {
        hypothesis: {
          id: "H4",
          label: "Air-management/EGR-related problem",
          claim: "EGR or unmetered air behaviour could disturb combustion.",
          possibleCauses: [
            "EGR valve or EGR passage fault",
            "vacuum or intake air leak",
          ],
        },
        mentions: [],
      },
      {
        hypothesis: {
          id: "H5",
          label: "Electrical/wiring problem",
          claim: "A wiring or connector fault could produce the reported codes.",
          possibleCauses: [
            "chafed, broken, or shorted wiring",
            "corroded or loose connector, or poor ground",
          ],
        },
        mentions: [],
      },
    ],
    unmentionedEvidence: [],
  };
}

// A complete assessment fixture with configurable support and unknowns.
function sampleAssessment(
  overrides?: Partial<DiagnosticAssessment>
): DiagnosticAssessment {
  return {
    hypothesisAssessments: [
      {
        hypothesisId: "H1",
        support: "moderately-supported",
        explanation: "Ignition remains plausible from collected sources.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H2",
        support: "insufficient-evidence",
        explanation: "Fuel delivery is not yet evidenced.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H3",
        support: "insufficient-evidence",
        explanation: "Mechanical causes are not yet evidenced.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H4",
        support: "weakly-supported",
        explanation: "Air-management codes are present but not confirmed as root cause.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H5",
        support: "insufficient-evidence",
        explanation: "Wiring causes are not yet evidenced.",
        supportingEvidence: [],
        contradictingEvidence: [],
      },
    ],
    conflicts: [],
    unknowns: [],
    recommendedNextTest: {
      name: "Compression test cylinder 5",
      purpose: "Check mechanical contribution to the misfire.",
      procedure: ["Perform a compression test on cylinder 5 and compare to adjacent cylinders."],
      distinguishes: ["H3", "H1"],
    },
    reasoning: "Several hypotheses remain open after the first research round.",
    ...overrides,
  };
}

// Investigation state for planner tests; assessment is omitted when testing that gate.
function sampleState(
  overrides?: Partial<InvestigationState>
): InvestigationState {
  return {
    diagnosticCase,
    evidence: [],
    hypothesisBoard: sampleBoard(),
    assessment: sampleAssessment(),
    researchRound: 1,
    attemptedQueries: ["Mercedes-Benz C240 W203 P0305"],
    unresolvedQuestions: [],
    status: "needs-follow-up",
    ...overrides,
  };
}

describe("planFollowUpResearch", () => {
  it("returns an empty list when there is no assessment", () => {
    const state = sampleState({
      assessment: undefined,
      unresolvedQuestions: ["Whether compression testing has been performed on cylinder 5"],
    });

    assert.deepEqual(planFollowUpResearch(state), []);
  });

  it("returns an empty list when the assessment has no unresolved questions", () => {
    const state = sampleState({
      unresolvedQuestions: [],
    });

    assert.deepEqual(planFollowUpResearch(state), []);
  });

  it("creates one objective for one unresolved question", () => {
    const question = "Whether compression testing has been performed on cylinder 5";
    const state = sampleState({
      unresolvedQuestions: [question],
    });

    const objectives = planFollowUpResearch(state);

    assert.equal(objectives.length, 1);
    assert.equal(objectives[0]?.id, "objective-1");
    assert.ok(objectives[0]?.question.includes(question));
    assert.ok(objectives[0]?.rationale.length > 0);
  });

  it("creates bounded objectives for multiple unresolved questions", () => {
    const state = sampleState({
      unresolvedQuestions: [
        "Whether compression testing has been performed on cylinder 5",
        "Whether injector contribution has been ruled out for cylinder 5",
        "Whether EGR flow testing has been documented for this vehicle",
        "Whether coil swap results were recorded",
      ],
    });

    const objectives = planFollowUpResearch(state);

    assert.equal(objectives.length, 3);
    assert.equal(objectives[0]?.id, "objective-1");
    assert.equal(objectives[1]?.id, "objective-2");
    assert.equal(objectives[2]?.id, "objective-3");
  });

  it("does not create duplicate objectives for duplicate unresolved questions", () => {
    const question = "Whether compression testing has been performed on cylinder 5";
    const state = sampleState({
      unresolvedQuestions: [question, question, `  ${question}  `],
    });

    const objectives = planFollowUpResearch(state);

    assert.equal(objectives.length, 1);
  });

  it("preserves vehicle context in the generated objective", () => {
    const state = sampleState({
      unresolvedQuestions: ["Whether compression testing has been performed on cylinder 5"],
    });

    const objectives = planFollowUpResearch(state);
    const text = objectives[0]?.question ?? "";

    assert.ok(text.includes("Mercedes-Benz"));
    assert.ok(text.includes("C240"));
    assert.ok(text.includes("W203"));
    assert.ok(text.includes("P0305"));
  });

  it("preserves deterministic ordering of unresolved questions", () => {
    const state = sampleState({
      unresolvedQuestions: [
        "Whether EGR flow testing has been documented for this vehicle",
        "Whether compression testing has been performed on cylinder 5",
        "Whether injector contribution has been ruled out for cylinder 5",
      ],
    });

    const first = planFollowUpResearch(state);
    const second = planFollowUpResearch(state);

    assert.deepEqual(
      first.map((item) => item.question),
      second.map((item) => item.question)
    );
    assert.ok(first[0]?.question.includes("EGR flow testing"));
    assert.ok(first[1]?.question.includes("compression testing"));
    assert.ok(first[2]?.question.includes("injector contribution"));
  });

  it("includes hypothesis relationships only when supported by existing state", () => {
    const withBoardSupport = sampleState({
      unresolvedQuestions: ["Whether compression testing has been performed on cylinder 5"],
    });
    const withoutBoardSupport = sampleState({
      unresolvedQuestions: ["Whether freeze-frame data was captured at the time of the fault"],
    });

    const linked = planFollowUpResearch(withBoardSupport);
    const unlinked = planFollowUpResearch(withoutBoardSupport);

    assert.deepEqual(linked[0]?.relatedHypotheses, ["H3"]);
    assert.deepEqual(unlinked[0]?.relatedHypotheses, []);
  });

  it("enforces the maximum objective count", () => {
    const state = sampleState({
      unresolvedQuestions: [
        "Question one about ignition coil history",
        "Question two about fuel injector testing",
        "Question three about compression testing",
        "Question four about EGR passage cleaning",
        "Question five about wiring continuity checks",
      ],
    });

    const objectives = planFollowUpResearch(state);

    assert.equal(objectives.length, 3);
  });
});
