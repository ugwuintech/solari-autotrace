import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAssessment } from "../src/llm/parseAssessment.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { Evidence } from "../src/types/evidence.js";
import type { HypothesisBoard } from "../src/types/hypothesis.js";
import type { ReasoningRequest } from "../src/types/reasoning.js";

// Shape of a model payload before validation. Fields stay strings so a test can supply an illegal value.
type ModelEvidenceReference = {
  title: string;
  url: string;
};

type ModelHypothesisAssessment = {
  hypothesisId: string;
  support: string;
  explanation: string;
  supportingEvidence: ModelEvidenceReference[];
  contradictingEvidence: ModelEvidenceReference[];
};

type ModelRecommendedTest = {
  name: string;
  purpose: string;
  procedure: string[];
  distinguishes: string[];
};

type ModelAssessment = {
  hypothesisAssessments: ModelHypothesisAssessment[];
  conflicts: Array<{
    description: string;
    references: ModelEvidenceReference[];
    affectedHypotheses: string[];
  }>;
  unknowns: Array<{
    question: string;
    whyItMatters: string;
  }>;
  recommendedNextTest?: ModelRecommendedTest;
  reasoning: string;
};

const coilEvidence: Evidence = {
  title: "Cylinder 5 coil swap",
  url: "https://example.test/coil",
  finding: "A coil swap moved the misfire with the coil.",
  relevance: "supports",
};

const egrEvidence: Evidence = {
  title: "EGR passage notes",
  url: "https://example.test/egr",
  finding: "Restricted EGR passages are discussed as an idle concern.",
  relevance: "context",
};

const h1Explanation = "A coil swap moved the misfire, which fits an ignition fault.";
const h2Explanation = "The collected pages do not describe injector or fuel-pressure tests.";
const testName = "Swap the cylinder 5 coil";
const testPurpose = "See whether the misfire follows the coil.";
const testStep = "Swap the cylinder 5 coil with another cylinder and clear the codes.";
const reasoning = "Ignition remains plausible and fuel delivery is not yet evidenced.";

// A request whose hypothesis ids and evidence URLs are the only ones the parser may accept.
function sampleRequest(): ReasoningRequest {
  const diagnosticCase: DiagnosticCase = {
    vehicle: {
      make: "Mercedes-Benz",
      model: "C240",
      platform: "W203",
    },
    codes: [{ code: "P0305", description: "Cylinder 5 misfire" }],
  };

  const board: HypothesisBoard = {
    hypotheses: [
      {
        hypothesis: {
          id: "H1",
          label: "Ignition-related misfire",
          claim: "A fault in the ignition path could produce the misfire.",
          possibleCauses: ["failed ignition coil"],
        },
        mentions: [],
      },
      {
        hypothesis: {
          id: "H2",
          label: "Fuel delivery problem",
          claim: "A fuel delivery fault could produce the misfire.",
          possibleCauses: ["failed injector"],
        },
        mentions: [],
      },
    ],
    unmentionedEvidence: [],
  };

  return {
    diagnosticCase,
    board,
    evidence: [coilEvidence, egrEvidence],
  };
}

// A complete assessment that names only hypotheses and URLs present on the sample request.
function validAssessment(): ModelAssessment {
  return {
    hypothesisAssessments: [
      {
        hypothesisId: "H1",
        support: "moderately-supported",
        explanation: h1Explanation,
        supportingEvidence: [{ title: coilEvidence.title, url: coilEvidence.url }],
        contradictingEvidence: [],
      },
      {
        hypothesisId: "H2",
        support: "insufficient-evidence",
        explanation: h2Explanation,
        supportingEvidence: [],
        contradictingEvidence: [],
      },
    ],
    conflicts: [],
    unknowns: [],
    recommendedNextTest: {
      name: testName,
      purpose: testPurpose,
      procedure: [testStep],
      distinguishes: ["H1"],
    },
    reasoning,
  };
}

// Serialize a fixture the way model output arrives: one JSON string, with no live model involved.
function modelJson(assessment: ModelAssessment): string {
  return JSON.stringify(assessment);
}

// The first hypothesis entry, so a test can change one field of a fresh valid assessment.
function firstHypothesis(assessment: ModelAssessment): ModelHypothesisAssessment {
  const entry = assessment.hypothesisAssessments[0];
  if (entry === undefined) {
    throw new Error("fixture has no hypothesis assessments");
  }
  return entry;
}

// The recommended test on a fixture that is expected to include one.
function recommendedTest(assessment: ModelAssessment): ModelRecommendedTest {
  if (assessment.recommendedNextTest === undefined) {
    throw new Error("fixture is missing recommendedNextTest");
  }
  return assessment.recommendedNextTest;
}

// Fail unless parseAssessment throws an error whose message identifies the rejected boundary.
function assertRejected(text: string, request: ReasoningRequest, messageIncludes: string): void {
  assert.throws(
    () => {
      parseAssessment(text, request);
    },
    (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(messageIncludes),
        `expected message to include ${JSON.stringify(messageIncludes)}, received: ${error.message}`
      );
      return true;
    }
  );
}

describe("parseAssessment", () => {
  it("accepts a valid DiagnosticAssessment", () => {
    const assessment = parseAssessment(modelJson(validAssessment()), sampleRequest());

    assert.deepEqual(assessment, {
      hypothesisAssessments: [
        {
          hypothesisId: "H1",
          support: "moderately-supported",
          explanation: h1Explanation,
          supportingEvidence: [{ title: coilEvidence.title, url: coilEvidence.url }],
          contradictingEvidence: [],
        },
        {
          hypothesisId: "H2",
          support: "insufficient-evidence",
          explanation: h2Explanation,
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
      conflicts: [],
      unknowns: [],
      recommendedNextTest: {
        name: testName,
        purpose: testPurpose,
        procedure: [testStep],
        distinguishes: ["H1"],
      },
      reasoning,
    });
  });

  it("rejects non-JSON output", () => {
    assertRejected(
      "The ignition coil should be replaced.",
      sampleRequest(),
      "contained no JSON object"
    );
  });

  it("rejects truncated or invalid JSON", () => {
    assertRejected(
      "{\"hypothesisAssessments\":}",
      sampleRequest(),
      "not valid JSON"
    );
  });

  it("rejects an evidence reference whose URL was not supplied", () => {
    const payload = validAssessment();
    const inventedUrl = "https://example.test/not-collected";
    firstHypothesis(payload).supportingEvidence = [{ title: coilEvidence.title, url: inventedUrl }];

    assertRejected(modelJson(payload), sampleRequest(), inventedUrl);
  });

  it("rejects an unknown hypothesis ID", () => {
    const payload = validAssessment();
    firstHypothesis(payload).hypothesisId = "H9";

    assertRejected(modelJson(payload), sampleRequest(), "not one of the hypotheses supplied");
  });

  it("rejects missing hypothesis coverage", () => {
    const payload = validAssessment();
    payload.hypothesisAssessments = [firstHypothesis(payload)];

    assertRejected(modelJson(payload), sampleRequest(), "does not assess every hypothesis");
  });

  it("rejects a missing recommendedNextTest", () => {
    const payload = validAssessment();
    delete payload.recommendedNextTest;

    assertRejected(modelJson(payload), sampleRequest(), "recommendedNextTest");
  });

  it("rejects a recommendedNextTest with an empty procedure", () => {
    const payload = validAssessment();
    recommendedTest(payload).procedure = [];

    assertRejected(modelJson(payload), sampleRequest(), "contains no steps");
  });

  it("rejects an invalid hypothesis support value", () => {
    const payload = validAssessment();
    firstHypothesis(payload).support = "proven";

    assertRejected(modelJson(payload), sampleRequest(), "not one of:");
  });

  it("uses the evidence-store title for a valid evidence reference", () => {
    const payload = validAssessment();
    const cited = firstHypothesis(payload).supportingEvidence[0];
    if (cited === undefined) {
      throw new Error("fixture is missing the coil evidence reference");
    }
    cited.title = "Model supplied replacement title";

    const assessment = parseAssessment(modelJson(payload), sampleRequest());
    const stored = assessment.hypothesisAssessments[0]?.supportingEvidence[0];

    assert.ok(stored);
    assert.equal(stored.title, coilEvidence.title);
    assert.equal(stored.url, coilEvidence.url);
  });
});
