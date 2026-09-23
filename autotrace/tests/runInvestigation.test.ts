import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RESEARCH_ROUNDS,
  runInvestigation,
} from "../src/agent/investigate.js";
import type { LlmProvider } from "../src/llm/provider.js";
import { buildHypothesisBoard } from "../src/reasoning/hypotheses.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { Evidence } from "../src/types/evidence.js";
import type {
  FollowUpResearchContext,
  FollowUpResearchResult,
} from "../src/types/followUpResearch.js";
import type { InvestigationState } from "../src/types/investigation.js";
import type { DiagnosticAssessment, ReasoningRequest } from "../src/types/reasoning.js";
import type { ResearchObjective } from "../src/types/researchObjective.js";

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

// Build a minimal evidence fixture for orchestration tests.
function sampleEvidence(url: string, finding = "A technical finding."): Evidence {
  return {
    title: `Source for ${url}`,
    url,
    finding,
    relevance: "context",
  };
}

// Build a complete assessment fixture with configurable unknowns.
function sampleAssessment(
  unknowns: Array<{ question: string; whyItMatters: string }> = []
): DiagnosticAssessment {
  return {
    hypothesisAssessments: [
      {
        hypothesisId: "H1",
        support: "moderately-supported",
        explanation: "Ignition evidence was present in the collected sources.",
        supportingEvidence: [{ title: "Source", url: "https://example.com/a" }],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H2",
        support: "insufficient-evidence",
        explanation: "Fuel delivery was not addressed by the collected sources.",
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
        explanation: "Air-management codes were discussed without a confirmed mechanism.",
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
    unknowns,
    recommendedNextTest: {
      name: "Cylinder 5 ignition coil swap test",
      purpose: "Check whether the misfire moves with the coil.",
      procedure: ["Swap coil", "Clear codes", "Road test"],
      distinguishes: ["H1", "H2"],
    },
    reasoning: "Several hypotheses remain open after research.",
  };
}

// Build a research objective fixture for follow-up planning stubs.
function sampleObjective(
  overrides?: Partial<ResearchObjective>
): ResearchObjective {
  return {
    id: "objective-1",
    question:
      "Find technical evidence relevant to mechanical/compression causes of P0305 " +
      "on the Mercedes-Benz C240 W203, especially evidence that helps address: " +
      "Whether compression testing has been performed on cylinder 5",
    rationale: "Insufficient evidence for the mechanical/compression hypothesis.",
    relatedHypotheses: ["H3"],
    ...overrides,
  };
}

// Counting mock provider that returns scripted assessments in call order.
function createMockProvider(
  assessments: DiagnosticAssessment[]
): LlmProvider & { calls: ReasoningRequest[] } {
  const calls: ReasoningRequest[] = [];
  let index = 0;

  return {
    name: "mock-provider",
    calls,
    async reason(request: ReasoningRequest): Promise<DiagnosticAssessment> {
      calls.push(request);
      const next = assessments[index];
      index += 1;
      if (next === undefined) {
        throw new Error("Mock provider was called more times than assessments were supplied");
      }
      return next;
    },
  };
}

// Scripted research runner that returns canned queries and evidence per call.
function createResearchStub(
  rounds: Array<{ queries: string[]; evidence: Evidence[] }>
) {
  let callCount = 0;
  return async () => {
    const next = rounds[callCount];
    callCount += 1;
    if (next === undefined) {
      throw new Error("Research stub was called more times than rounds were supplied");
    }
    return next;
  };
}

describe("runInvestigation", () => {
  it("stops after one round when the assessment has no unresolved questions", async () => {
    const evidence = [sampleEvidence("https://example.com/a")];
    const researchStub = createResearchStub([
      { queries: ["query-round-1"], evidence },
    ]);
    const provider = createMockProvider([sampleAssessment([])]);
    let followUpCalls = 0;

    const result = await runInvestigation(diagnosticCase, {
      research: researchStub,
      provider,
      executeFollowUpResearch: async () => {
        followUpCalls += 1;
        return {
          attemptedObjectives: [],
          executedQueries: [],
          skippedQueries: [],
          newEvidence: [],
          failures: [],
        };
      },
    });

    assert.equal(result.state.status, "complete");
    assert.equal(result.state.researchRound, 1);
    assert.equal(result.state.unresolvedQuestions.length, 0);
    assert.equal(result.reasoningCalls, 1);
    assert.equal(provider.calls.length, 1);
    assert.equal(followUpCalls, 0);
    assert.equal(result.followUpObjectives.length, 0);
  });

  it("runs round 2 when unresolved questions produce a follow-up objective", async () => {
    const round1Evidence = [sampleEvidence("https://example.com/a")];
    const round2Evidence = [sampleEvidence("https://example.com/b")];
    const researchStub = createResearchStub([
      { queries: ["query-round-1"], evidence: round1Evidence },
    ]);
    const provider = createMockProvider([
      sampleAssessment([
        {
          question: "Whether compression testing has been performed on cylinder 5",
          whyItMatters: "Rules mechanical causes in or out.",
        },
      ]),
      sampleAssessment([]),
    ]);
    const objective = sampleObjective();
    let executeCalls = 0;

    const result = await runInvestigation(diagnosticCase, {
      research: researchStub,
      provider,
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => {
        executeCalls += 1;
        return {
          attemptedObjectives: [objective],
          executedQueries: ["follow-up-query"],
          skippedQueries: [],
          newEvidence: round2Evidence,
          failures: [],
        };
      },
    });

    assert.equal(executeCalls, 1);
    assert.equal(result.state.researchRound, 2);
    assert.equal(result.state.status, "complete");
    assert.equal(result.followUpObjectives.length, 1);
    assert.equal(result.newEvidenceFromFollowUp.length, 1);
    assert.equal(result.reasoningCalls, 2);
  });

  it("combines round-2 evidence with round-1 evidence in the final state", async () => {
    const round1Evidence = [sampleEvidence("https://example.com/a")];
    const round2Evidence = [sampleEvidence("https://example.com/b")];
    const objective = sampleObjective();

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({ queries: ["q1"], evidence: round1Evidence }),
      provider: createMockProvider([
        sampleAssessment([
          {
            question: "Whether compression testing has been performed on cylinder 5",
            whyItMatters: "Mechanical causes remain open.",
          },
        ]),
        sampleAssessment([]),
      ]),
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        newEvidence: round2Evidence,
        failures: [],
      }),
    });

    assert.equal(result.state.evidence.length, 2);
    assert.deepEqual(
      result.state.evidence.map((item) => item.url),
      ["https://example.com/a", "https://example.com/b"]
    );
  });

  it("rebuilds the hypothesis board using all evidence from both rounds", async () => {
    const round1Evidence = [
      sampleEvidence("https://example.com/a", "Ignition coil failure discussed for cylinder 5."),
    ];
    const round2Evidence = [
      sampleEvidence("https://example.com/b", "Compression test procedure for the affected cylinder."),
    ];
    const objective = sampleObjective();
    const provider = createMockProvider([
      sampleAssessment([
        {
          question: "Whether compression testing has been performed on cylinder 5",
          whyItMatters: "Mechanical causes remain open.",
        },
      ]),
      sampleAssessment([]),
    ]);

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({ queries: ["q1"], evidence: round1Evidence }),
      provider,
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        newEvidence: round2Evidence,
        failures: [],
      }),
    });

    assert.equal(provider.calls.length, 2);
    const secondRequest = provider.calls[1];
    assert.ok(secondRequest);
    assert.equal(secondRequest.evidence.length, 2);

    const expectedBoard = buildHypothesisBoard([
      ...round1Evidence,
      ...round2Evidence,
    ]);
    assert.deepEqual(secondRequest.board, expectedBoard);
    assert.deepEqual(result.state.hypothesisBoard, expectedBoard);
  });

  it("calls the reasoning provider at most twice", async () => {
    const objective = sampleObjective();
    const provider = createMockProvider([
      sampleAssessment([
        {
          question: "Whether compression testing has been performed on cylinder 5",
          whyItMatters: "Mechanical causes remain open.",
        },
      ]),
      sampleAssessment([
        {
          question: "Still unresolved after round 2",
          whyItMatters: "Would normally justify more research.",
        },
      ]),
    ]);

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["q1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider,
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        newEvidence: [sampleEvidence("https://example.com/b")],
        failures: [],
      }),
    });

    assert.equal(provider.calls.length, 2);
    assert.equal(result.reasoningCalls, 2);
    assert.ok(result.reasoningCalls <= MAX_RESEARCH_ROUNDS);
  });

  it("does not start a third research round when round 2 still has unresolved questions", async () => {
    const objective = sampleObjective();
    let planCalls = 0;
    let executeCalls = 0;
    const provider = createMockProvider([
      sampleAssessment([
        {
          question: "Whether compression testing has been performed on cylinder 5",
          whyItMatters: "Mechanical causes remain open.",
        },
      ]),
      sampleAssessment([
        {
          question: "Whether injector balance was measured on cylinder 5",
          whyItMatters: "Fuel delivery remains open after follow-up.",
        },
      ]),
    ]);

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["q1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider,
      planFollowUpResearch: (state: InvestigationState) => {
        planCalls += 1;
        assert.equal(state.researchRound, 1);
        return [objective];
      },
      executeFollowUpResearch: async () => {
        executeCalls += 1;
        return {
          attemptedObjectives: [objective],
          executedQueries: ["follow-up-query"],
          skippedQueries: [],
          newEvidence: [sampleEvidence("https://example.com/b")],
          failures: [],
        };
      },
    });

    assert.equal(planCalls, 1);
    assert.equal(executeCalls, 1);
    assert.equal(result.state.researchRound, 2);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.unresolvedQuestions.length, 1);
    assert.match(
      result.state.unresolvedQuestions[0] ?? "",
      /injector balance/
    );
  });

  it("does not duplicate evidence URLs across rounds in the final state", async () => {
    const shared = sampleEvidence("https://example.com/shared");
    const unique = sampleEvidence("https://example.com/unique");
    const objective = sampleObjective();

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({ queries: ["q1"], evidence: [shared] }),
      provider: createMockProvider([
        sampleAssessment([
          {
            question: "Whether compression testing has been performed on cylinder 5",
            whyItMatters: "Mechanical causes remain open.",
          },
        ]),
        sampleAssessment([]),
      ]),
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        // Follow-up already URL-dedupes; orchestration also combines safely.
        newEvidence: [unique],
        failures: [],
      }),
    });

    const urls = result.state.evidence.map((item) => item.url.toLowerCase());
    assert.equal(new Set(urls).size, urls.length);
    assert.equal(result.state.evidence.length, 2);
  });

  it("does not call the LLM when initial research returns no evidence", async () => {
    const provider = createMockProvider([sampleAssessment([])]);
    let planCalls = 0;

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({ queries: ["q1"], evidence: [] }),
      provider,
      planFollowUpResearch: () => {
        planCalls += 1;
        return [];
      },
    });

    assert.equal(provider.calls.length, 0);
    assert.equal(result.reasoningCalls, 0);
    assert.equal(planCalls, 0);
    assert.equal(result.state.assessment, undefined);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.evidence.length, 0);
    assert.equal(result.state.researchRound, 1);
  });

  it("preserves the round-1 assessment when follow-up finds no new evidence", async () => {
    const round1Assessment = sampleAssessment([
      {
        question: "Whether compression testing has been performed on cylinder 5",
        whyItMatters: "Mechanical causes remain open.",
      },
    ]);
    const objective = sampleObjective();
    const provider = createMockProvider([
      round1Assessment,
      sampleAssessment([]),
    ]);

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["q1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider,
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        newEvidence: [],
        failures: [],
      }),
    });

    assert.equal(provider.calls.length, 1);
    assert.equal(result.reasoningCalls, 1);
    assert.equal(result.state.assessment, round1Assessment);
    assert.deepEqual(result.state.unresolvedQuestions, [
      "Whether compression testing has been performed on cylinder 5",
    ]);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.researchRound, 2);
  });

  it("does not treat follow-up research failures as evidence", async () => {
    const round1Assessment = sampleAssessment([
      {
        question: "Whether compression testing has been performed on cylinder 5",
        whyItMatters: "Mechanical causes remain open.",
      },
    ]);
    const objective = sampleObjective();
    const provider = createMockProvider([round1Assessment]);

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["q1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider,
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        newEvidence: [],
        failures: [
          {
            objective,
            query: "follow-up-query",
            reason: "AutoTrace research failed: network error",
          },
        ],
      }),
    });

    assert.equal(result.state.evidence.length, 1);
    assert.equal(result.newEvidenceFromFollowUp.length, 0);
    assert.equal(result.followUpFailures.length, 1);
    assert.equal(provider.calls.length, 1);
    assert.equal(result.state.assessment, round1Assessment);
  });

  it("marks the investigation complete after round 2", async () => {
    const objective = sampleObjective();

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["q1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider: createMockProvider([
        sampleAssessment([
          {
            question: "Whether compression testing has been performed on cylinder 5",
            whyItMatters: "Mechanical causes remain open.",
          },
        ]),
        sampleAssessment([]),
      ]),
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async () => ({
        attemptedObjectives: [objective],
        executedQueries: ["follow-up-query"],
        skippedQueries: [],
        newEvidence: [sampleEvidence("https://example.com/b")],
        failures: [],
      }),
    });

    assert.equal(result.state.status, "complete");
    assert.equal(result.state.researchRound, MAX_RESEARCH_ROUNDS);
  });

  it("records only actually executed queries in attemptedQueries", async () => {
    const objective = sampleObjective();
    let receivedContext: FollowUpResearchContext | undefined;

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["executed-round-1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider: createMockProvider([
        sampleAssessment([
          {
            question: "Whether compression testing has been performed on cylinder 5",
            whyItMatters: "Mechanical causes remain open.",
          },
        ]),
        sampleAssessment([]),
      ]),
      planFollowUpResearch: () => [objective],
      executeFollowUpResearch: async (_case, _objectives, context) => {
        receivedContext = context;
        return {
          attemptedObjectives: [objective],
          executedQueries: ["executed-round-2"],
          skippedQueries: ["proposed-but-skipped"],
          newEvidence: [sampleEvidence("https://example.com/b")],
          failures: [],
        };
      },
    });

    assert.deepEqual(receivedContext?.attemptedQueries, ["executed-round-1"]);
    assert.deepEqual(result.state.attemptedQueries, [
      "executed-round-1",
      "executed-round-2",
    ]);
    assert.ok(!result.state.attemptedQueries.includes("proposed-but-skipped"));
  });

  it("surfaces LLM failures without fabricating an assessment", async () => {
    const provider: LlmProvider = {
      name: "failing-provider",
      async reason(): Promise<DiagnosticAssessment> {
        throw new Error("AutoTrace reasoning failed: model unavailable");
      },
    };

    await assert.rejects(
      () =>
        runInvestigation(diagnosticCase, {
          research: async () => ({
            queries: ["q1"],
            evidence: [sampleEvidence("https://example.com/a")],
          }),
          provider,
        }),
      /AutoTrace reasoning failed: model unavailable/
    );
  });

  it("completes cleanly when the planner returns no objectives", async () => {
    const provider = createMockProvider([
      sampleAssessment([
        {
          question: "Whether compression testing has been performed on cylinder 5",
          whyItMatters: "Mechanical causes remain open.",
        },
      ]),
    ]);
    let executeCalls = 0;

    const result = await runInvestigation(diagnosticCase, {
      research: async () => ({
        queries: ["q1"],
        evidence: [sampleEvidence("https://example.com/a")],
      }),
      provider,
      planFollowUpResearch: () => [],
      executeFollowUpResearch: async (): Promise<FollowUpResearchResult> => {
        executeCalls += 1;
        return {
          attemptedObjectives: [],
          executedQueries: [],
          skippedQueries: [],
          newEvidence: [],
          failures: [],
        };
      },
    });

    assert.equal(executeCalls, 0);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.researchRound, 1);
    assert.equal(provider.calls.length, 1);
    assert.ok(result.state.assessment);
  });
});
