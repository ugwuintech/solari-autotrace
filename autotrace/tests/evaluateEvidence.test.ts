import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyMentionPolarity } from "../src/reasoning/evaluateEvidence.js";
import { buildHypothesisBoard } from "../src/reasoning/hypotheses.js";
import type { Evidence } from "../src/types/evidence.js";

// Build a minimal evidence fixture for board and polarity tests.
function evidence(finding: string, url = "https://example.test/source"): Evidence {
  return {
    title: "Forum diagnostic notes",
    url,
    finding,
    relevance: "context",
  };
}

describe("classifyMentionPolarity", () => {
  it("treats a bare component mention as contextual", () => {
    const result = classifyMentionPolarity(
      "Several technicians discussed the ignition coil and spark plug on cylinder 5 misfire cases.",
      ["coil", "spark plug", "ignition"]
    );

    assert.equal(result.polarity, "context");
    assert.match(result.reason, /without a clear supporting or contradicting finding/i);
  });

  it("treats a positive fault finding as supporting", () => {
    const result = classifyMentionPolarity(
      "A coil swap moved the misfire with the coil to cylinder 1.",
      ["coil"]
    );

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /followed or moved/i);
  });

  it("treats a failed intervention where the problem remained as contradicting", () => {
    const result = classifyMentionPolarity(
      "The ignition coil and fuel injector were swapped and tested, wiring was checked, and the P0305 misfire remained.",
      ["coil", "ignition"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /intervention|unchanged/i);
  });

  it("treats normal compression as contradicting a compression hypothesis", () => {
    const result = classifyMentionPolarity(
      "A compression test showed compression was equal across all cylinders.",
      ["compression", "compression test"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /normal or equal compression/i);
  });

  it("does not treat a failed ignition intervention as contradicting an unrelated EGR mention", () => {
    const text =
      "The coil was swapped with no change. Restricted EGR passages are often discussed for idle quality.";

    const ignition = classifyMentionPolarity(text, ["coil"]);
    const egr = classifyMentionPolarity(text, ["egr"]);

    assert.equal(ignition.polarity, "contradicts");
    assert.equal(egr.polarity, "context");
  });
});

describe("buildHypothesisBoard polarity", () => {
  it("keeps existing mention attachment and adds polarity without dropping evidence", () => {
    const items = [
      evidence(
        "Technicians often inspect the spark plug and coil when diagnosing a cylinder misfire.",
        "https://example.test/context"
      ),
      evidence(
        "A failed injector on cylinder 5 produced a sustained misfire code.",
        "https://example.test/supports"
      ),
      evidence(
        "Coil and injector were replaced, wiring was checked, and the misfire remained.",
        "https://example.test/failed"
      ),
      evidence(
        "Compression was normal on all cylinders after a compression test.",
        "https://example.test/compression"
      ),
    ];

    const board = buildHypothesisBoard(items);

    const h1 = board.hypotheses.find((entry) => entry.hypothesis.id === "H1");
    const h2 = board.hypotheses.find((entry) => entry.hypothesis.id === "H2");
    const h3 = board.hypotheses.find((entry) => entry.hypothesis.id === "H3");
    const h5 = board.hypotheses.find((entry) => entry.hypothesis.id === "H5");

    assert.ok(h1);
    assert.ok(h2);
    assert.ok(h3);
    assert.ok(h5);

    const contextMention = h1.mentions.find((m) => m.evidence.url === "https://example.test/context");
    assert.ok(contextMention);
    assert.equal(contextMention.polarity, "context");
    assert.ok(contextMention.matchedTerms.length > 0);

    const supportMention = h2.mentions.find((m) => m.evidence.url === "https://example.test/supports");
    assert.ok(supportMention);
    assert.equal(supportMention.polarity, "supports");

    const failedIgnition = h1.mentions.find((m) => m.evidence.url === "https://example.test/failed");
    const failedFuel = h2.mentions.find((m) => m.evidence.url === "https://example.test/failed");
    const failedWiring = h5.mentions.find((m) => m.evidence.url === "https://example.test/failed");
    assert.ok(failedIgnition);
    assert.ok(failedFuel);
    assert.ok(failedWiring);
    assert.equal(failedIgnition.polarity, "contradicts");
    assert.equal(failedFuel.polarity, "contradicts");
    assert.equal(failedWiring.polarity, "contradicts");

    const compressionMention = h3.mentions.find((m) => m.evidence.url === "https://example.test/compression");
    assert.ok(compressionMention);
    assert.equal(compressionMention.polarity, "contradicts");

    // Evidence urls and findings remain intact on every mention.
    for (const entry of board.hypotheses) {
      for (const mention of entry.mentions) {
        assert.ok(mention.evidence.url.startsWith("https://example.test/"));
        assert.ok(mention.evidence.finding.length > 0);
        assert.ok(mention.polarityReason.length > 0);
      }
    }
  });
});
