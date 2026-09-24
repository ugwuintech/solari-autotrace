import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeFollowUpResearch } from "../src/research/executeFollowUpResearch.js";
import {
  buildFollowUpQuery,
  collectNewEvidence,
  extractObjectiveFocus,
  extractTechnicalFocusTerms,
  MAX_FOLLOW_UP_OBJECTIVES,
  normalizeResearchQuery,
  planFollowUpQueries,
} from "../src/research/followUpQuery.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { Evidence } from "../src/types/evidence.js";
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

// Build a research objective fixture with optional field overrides.
function sampleObjective(
  overrides?: Partial<ResearchObjective>
): ResearchObjective {
  return {
    id: "objective-1",
    question:
      "Find technical evidence relevant to mechanical/compression causes of P0305 on the Mercedes C240 W203.",
    rationale: "Insufficient evidence for the mechanical/compression hypothesis.",
    relatedHypotheses: ["H3"],
    ...overrides,
  };
}

// Ignition follow-up objective shaped like a live Round-2 unresolved question.
function ignitionObjective(): ResearchObjective {
  return sampleObjective({
    id: "objective-ignition",
    question:
      "Find technical evidence relevant to Ignition-related misfire explanations of P0305, P2001, P0400 " +
      "on the Mercedes-Benz C240 W203, especially evidence that helps address: " +
      "Is the misfire due to a specific ignition component failure or a more complex system issue?",
    relatedHypotheses: ["H1"],
  });
}

// EGR/air-management follow-up objective shaped like a live Round-2 unresolved question.
function egrObjective(): ResearchObjective {
  return sampleObjective({
    id: "objective-egr",
    question:
      "Find technical evidence relevant to Air-management/EGR-related problem explanations of P0305, P2001, P0400 " +
      "on the Mercedes-Benz C240 W203, especially evidence that helps address: " +
      "Are there any air-management or EGR-related issues contributing to the misfire?",
    relatedHypotheses: ["H4"],
  });
}

// Build a minimal evidence fixture for URL deduplication tests.
function sampleEvidence(url: string, title = "Source"): Evidence {
  return {
    title,
    url,
    finding: "A technical finding.",
    relevance: "context",
  };
}

describe("follow-up query construction", () => {
  it("builds a vehicle-and-code-focused technical query from an objective", () => {
    const query = buildFollowUpQuery(diagnosticCase, sampleObjective());
    assert.match(query, /Mercedes-Benz C240 W203/);
    assert.match(query, /P0305/);
    assert.match(query, /mechanical/i);
    assert.match(query, /compression/i);
    assert.match(query, /diagnostic/i);
    assert.match(query, /test/i);
    assert.doesNotMatch(query, /^Find technical evidence/i);
    assert.doesNotMatch(query, /Find technical evidence relevant to/i);
  });

  it("preserves vehicle context in follow-up queries", () => {
    const query = buildFollowUpQuery(diagnosticCase, ignitionObjective());
    assert.match(query, /Mercedes-Benz/);
    assert.match(query, /C240/);
    assert.match(query, /W203/);
  });

  it("keeps relevant DTC context without stuffing every case code", () => {
    const ignitionQuery = buildFollowUpQuery(diagnosticCase, ignitionObjective());
    const egrQuery = buildFollowUpQuery(diagnosticCase, egrObjective());

    assert.match(ignitionQuery, /P0305/);
    assert.doesNotMatch(ignitionQuery, /P0400/);
    assert.doesNotMatch(ignitionQuery, /P2001/);

    assert.match(egrQuery, /P0400|P2001/);
    assert.match(egrQuery, /EGR|air-management/i);
  });

  it("does not copy the full natural-language unresolved question into the query", () => {
    const unresolved =
      "Is the misfire due to a specific ignition component failure or a more complex system issue?";
    const query = buildFollowUpQuery(diagnosticCase, ignitionObjective());

    assert.equal(query.includes(unresolved), false);
    assert.doesNotMatch(query, /\bIs the misfire due to\b/);
    assert.doesNotMatch(query, /\bmore complex system issue\b/);
  });

  it("incorporates diagnostic and test oriented terms", () => {
    const query = buildFollowUpQuery(diagnosticCase, ignitionObjective());
    assert.match(query, /\bdiagnostic\b/i);
    assert.match(query, /\btest\b/i);
  });

  it("produces meaningfully different queries for different objectives", () => {
    const ignitionQuery = buildFollowUpQuery(diagnosticCase, ignitionObjective());
    const egrQuery = buildFollowUpQuery(diagnosticCase, egrObjective());

    assert.notEqual(
      normalizeResearchQuery(ignitionQuery),
      normalizeResearchQuery(egrQuery)
    );
    assert.match(ignitionQuery, /ignition|coil|spark/i);
    assert.match(egrQuery, /egr|air-management|vacuum/i);
  });

  it("extracts compact technical focus terms instead of question prose", () => {
    const terms = extractTechnicalFocusTerms(ignitionObjective());
    assert.ok(terms.some((term) => /ignition|coil|spark/i.test(term)));
    assert.ok(!terms.some((term) => /specific|complex|failure|component/i.test(term)));
  });

  it("prefers the unresolved-question tail when present", () => {
    const focus = extractObjectiveFocus(
      "Find technical evidence relevant to Ignition-related misfire explanations of P0305 " +
        "on the Mercedes-Benz C240 W203, especially evidence that helps address: " +
        "Is coil swap testing documented for cylinder 5?"
    );
    assert.equal(focus, "Is coil swap testing documented for cylinder 5?");
  });

  it("normalizes queries for duplicate comparison", () => {
    assert.equal(
      normalizeResearchQuery("  Mercedes-Benz   C240  W203  P0305  "),
      "mercedes-benz c240 w203 p0305"
    );
  });
});

describe("planFollowUpQueries", () => {
  it("skips objectives whose generated query was already attempted", () => {
    const objective = sampleObjective();
    const query = buildFollowUpQuery(diagnosticCase, objective);
    const planned = planFollowUpQueries(diagnosticCase, [objective], [
      `  ${query.toUpperCase()}  `,
    ]);

    assert.equal(planned.executable.length, 0);
    assert.deepEqual(planned.skippedQueries, [query]);
    assert.equal(planned.attemptedObjectives.length, 1);
  });

  it("caps attempted objectives at MAX_FOLLOW_UP_OBJECTIVES", () => {
    const focuses = [
      "ignition coil spark plug",
      "fuel injector pressure",
      "compression valve mechanical",
      "EGR vacuum intake",
      "wiring connector ground",
    ];
    const objectives = Array.from({ length: 5 }, (_, index) =>
      sampleObjective({
        id: `objective-${index + 1}`,
        question:
          `Find technical evidence relevant to ${focuses[index]} causes of P0305 ` +
          "on the Mercedes C240 W203.",
      })
    );

    const planned = planFollowUpQueries(diagnosticCase, objectives, []);
    assert.equal(planned.attemptedObjectives.length, MAX_FOLLOW_UP_OBJECTIVES);
    assert.equal(planned.executable.length, MAX_FOLLOW_UP_OBJECTIVES);
  });

  it("skips duplicate queries generated within the same round", () => {
    const first = sampleObjective({ id: "objective-1" });
    const second = sampleObjective({ id: "objective-2" });
    const planned = planFollowUpQueries(diagnosticCase, [first, second], []);

    assert.equal(planned.executable.length, 1);
    assert.equal(planned.skippedQueries.length, 1);
  });
});

describe("collectNewEvidence", () => {
  it("excludes evidence URLs already present in the existing collection", () => {
    const existing = [sampleEvidence("https://example.com/a")];
    const collected = [
      sampleEvidence("https://example.com/a"),
      sampleEvidence("https://example.com/b"),
      sampleEvidence("HTTPS://EXAMPLE.COM/B"),
    ];

    const fresh = collectNewEvidence(collected, existing);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]?.url, "https://example.com/b");
  });
});

describe("executeFollowUpResearch", () => {
  it("runs only new queries through the supplied research runner", async () => {
    const objective = sampleObjective({
      question:
        "Find technical evidence relevant to fuel delivery causes of P0305 on the Mercedes C240 W203.",
    });
    const expectedQuery = buildFollowUpQuery(diagnosticCase, objective);
    let receivedQueries: string[] | undefined;

    const result = await executeFollowUpResearch(
      diagnosticCase,
      [objective],
      {
        existingEvidence: [sampleEvidence("https://example.com/old")],
        attemptedQueries: [],
      },
      async (_diagnosticCase, options) => {
        receivedQueries = options?.queries;
        return {
          queries: options?.queries ?? [],
          evidence: [
            sampleEvidence("https://example.com/old"),
            sampleEvidence("https://example.com/new"),
          ],
        };
      }
    );

    assert.deepEqual(receivedQueries, [expectedQuery]);
    assert.deepEqual(result.executedQueries, [expectedQuery]);
    assert.deepEqual(result.skippedQueries, []);
    assert.equal(result.failures.length, 0);
    assert.equal(result.newEvidence.length, 1);
    assert.equal(result.newEvidence[0]?.url, "https://example.com/new");
  });

  it("records structured failures when research throws", async () => {
    const objective = sampleObjective({
      question:
        "Find technical evidence relevant to wiring causes of P0305 on the Mercedes C240 W203.",
    });

    const result = await executeFollowUpResearch(
      diagnosticCase,
      [objective],
      { existingEvidence: [], attemptedQueries: [] },
      async () => {
        throw new Error("AutoTrace research failed:\nQueries: test\nReason: network down");
      }
    );

    assert.equal(result.newEvidence.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.objective.id, objective.id);
    assert.match(result.failures[0]?.reason ?? "", /network down/);
  });

  it("does not call research when every objective query was already attempted", async () => {
    const objective = sampleObjective();
    const query = buildFollowUpQuery(diagnosticCase, objective);
    let called = false;

    const result = await executeFollowUpResearch(
      diagnosticCase,
      [objective],
      { existingEvidence: [], attemptedQueries: [query] },
      async () => {
        called = true;
        return { queries: [], evidence: [] };
      }
    );

    assert.equal(called, false);
    assert.deepEqual(result.executedQueries, []);
    assert.deepEqual(result.skippedQueries, [query]);
  });
});
