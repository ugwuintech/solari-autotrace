import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResearchQueries } from "../src/research/queries.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";

const baseCase: DiagnosticCase = {
  vehicle: {
    make: "Mercedes-Benz",
    model: "C240",
    platform: "W203",
  },
  codes: [{ code: "P0305" }, { code: "P0400" }],
};

describe("buildResearchQueries", () => {
  it("adds a symptom + primaryCode + chassis query when a symptom is present", () => {
    const queries = buildResearchQueries({
      ...baseCase,
      symptoms: ["rough idle on cylinder 5"],
    });

    assert.ok(queries.some((query) => query.includes("rough idle on cylinder 5")));
    assert.ok(queries.includes("rough idle on cylinder 5 P0305 W203"));
    assert.ok(!queries.some((query) => query.includes("mbworld.org")));
  });

  it("omits the symptom query when no symptom is available", () => {
    const queries = buildResearchQueries(baseCase);

    assert.ok(!queries.some((query) => /misfire site:mbworld\.org/.test(query)));
    assert.equal(
      queries.filter((query) => query.includes("P0305") && query.includes("W203")).length >= 1,
      true
    );
    assert.ok(!queries.some((query) => /^[^M].*P0305 W203$/.test(query) && !query.includes("Mercedes")));
  });

  it("uses the first non-empty symptom when several are supplied", () => {
    const queries = buildResearchQueries({
      ...baseCase,
      symptoms: ["  ", "cold start stumble", "rough idle"],
    });

    assert.ok(queries.includes("cold start stumble P0305 W203"));
    assert.ok(!queries.some((query) => query.includes("rough idle")));
  });
});
