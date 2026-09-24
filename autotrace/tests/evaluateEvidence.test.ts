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

  it("treats ignition intervention with persistent P0305 as contradicting", () => {
    const result = classifyMentionPolarity(
      "I have swapped all ignition components with no luck of misfires to follow and still getting P0305.",
      ["ignition"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /intervention|unchanged/i);
  });

  it("treats injector intervention with persistent P0305 as contradicting", () => {
    const result = classifyMentionPolarity(
      "I swapped the fuel injector and am still getting P0305.",
      ["injector", "fuel injector"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /intervention|unchanged/i);
  });

  it("treats spark plug and coil swap with persistent misfire as contradicting", () => {
    const result = classifyMentionPolarity(
      "I replaced the spark plugs, moved the coil and plug wires, and still have the misfire.",
      ["spark plug", "coil", "plug wires"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /intervention|unchanged/i);
  });

  it("treats even compression readings across cylinders as contradicting", () => {
    const result = classifyMentionPolarity(
      "I have checked compression (175-190 every cylinder).",
      ["compression"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /normal or equal compression/i);
  });

  it("treats general coil discussion as contextual", () => {
    const result = classifyMentionPolarity("coils are expensive on this engine", ["coil"]);

    assert.equal(result.polarity, "context");
  });

  it("treats general injector discussion as contextual", () => {
    const result = classifyMentionPolarity(
      "I suspect the injector might be worth looking at later",
      ["injector"]
    );

    assert.equal(result.polarity, "context");
  });

  it("treats replaced EGR without an outcome as contextual", () => {
    const result = classifyMentionPolarity("replaced EGR valve", ["egr"]);

    assert.equal(result.polarity, "context");
  });

  it("treats replaced EGR with persistent P0400 as contradicting", () => {
    const result = classifyMentionPolarity(
      "replaced EGR valve and P0400 remains",
      ["egr"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /intervention|unchanged/i);
  });

  it("treats misfire moving after a coil swap as supporting", () => {
    const result = classifyMentionPolarity(
      "misfire moved from cylinder 5 to cylinder 4 after swapping the coil",
      ["coil"]
    );

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /followed or moved/i);
  });

  it("treats low compression on the affected cylinder as supporting", () => {
    const result = classifyMentionPolarity(
      "cylinder 5 compression was significantly lower",
      ["compression"]
    );

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /low or weak compression/i);
  });

  it("treats a positive injector finding as supporting", () => {
    const result = classifyMentionPolarity("injector flow was low on cylinder 5", ["injector"]);

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /abnormal measurement|below-spec|fault/i);
  });

  it("treats a damaged wiring finding as supporting", () => {
    const result = classifyMentionPolarity("found damaged wiring near the harness", ["wiring"]);

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /fault/i);
  });

  it("treats a general wiring mention as contextual", () => {
    const result = classifyMentionPolarity("checked the wiring on the harness", ["wiring"]);

    assert.equal(result.polarity, "context");
  });

  it("preserves scoped low compression when normal compression covers other cylinders", () => {
    const result = classifyMentionPolarity(
      "Compression was normal on cylinders 1-3. Cylinder 4 has low compression.",
      ["compression"]
    );

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /low or weak compression/i);
  });

  it("does not let a broad normal compression reading erase scoped low compression", () => {
    const result = classifyMentionPolarity(
      "Compression was normal on all cylinders, but cylinder 5 showed low compression.",
      ["compression"]
    );

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /low or weak compression/i);
  });

  it("applies persistence only to the intervention clause it belongs to", () => {
    const text =
      "Swapped the coil and the misfire remained. Later the injector was replaced.";

    const coil = classifyMentionPolarity(text, ["coil"]);
    const injector = classifyMentionPolarity(text, ["injector"]);

    assert.equal(coil.polarity, "contradicts");
    assert.match(coil.reason, /intervention|unchanged/i);
    assert.equal(injector.polarity, "context");
  });

  it("still contradicts when persistence follows the same-clause intervention", () => {
    const result = classifyMentionPolarity(
      "Swapped the coil and the misfire remained.",
      ["coil"]
    );

    assert.equal(result.polarity, "contradicts");
    assert.match(result.reason, /intervention|unchanged/i);
  });

  it("does not treat a vacuum leak statement as compression evidence", () => {
    const result = classifyMentionPolarity(
      "Found a vacuum leak near the intake. Compression was normal on all cylinders.",
      ["vacuum leak"]
    );

    assert.notEqual(result.polarity, "contradicts");
    assert.equal(/normal or equal compression/i.test(result.reason), false);
  });

  it("does not treat negated fault adjectives as supporting", () => {
    const result = classifyMentionPolarity("the coil is not bad", ["coil"]);

    assert.equal(result.polarity, "context");
  });

  it("still treats a positive fault adjective as supporting", () => {
    const result = classifyMentionPolarity("the coil is bad", ["coil"]);

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /fault/i);
  });

  it("does not treat a negated resolution as supporting", () => {
    const result = classifyMentionPolarity(
      "Replaced the coil but not fixed the misfire",
      ["coil"]
    );

    assert.notEqual(result.polarity, "supports");
  });

  it("still treats a positive resolution after intervention as supporting", () => {
    const result = classifyMentionPolarity(
      "Replaced the coil and that fixed the misfire",
      ["coil"]
    );

    assert.equal(result.polarity, "supports");
    assert.match(result.reason, /resolved after intervening/i);
  });

  it("supports follow findings only when the named component matches", () => {
    const matching = classifyMentionPolarity(
      "The misfire followed the coil to cylinder 1.",
      ["coil"]
    );
    const unrelated = classifyMentionPolarity(
      "The misfire followed the injector; the coil pack was also discussed.",
      ["coil"]
    );

    assert.equal(matching.polarity, "supports");
    assert.match(matching.reason, /followed or moved/i);
    assert.equal(unrelated.polarity, "context");
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

  it("marks ignition and fuel as contradicted when both were swapped without the misfire following", () => {
    const board = buildHypothesisBoard([
      evidence(
        "I have swapped all ignition components and fuel injector with no luck of misfires to follow.",
        "https://example.test/live-swap"
      ),
    ]);

    const h1 = board.hypotheses.find((entry) => entry.hypothesis.id === "H1");
    const h2 = board.hypotheses.find((entry) => entry.hypothesis.id === "H2");
    assert.ok(h1);
    assert.ok(h2);

    const ignition = h1.mentions.find((m) => m.evidence.url === "https://example.test/live-swap");
    const fuel = h2.mentions.find((m) => m.evidence.url === "https://example.test/live-swap");
    assert.ok(ignition);
    assert.ok(fuel);
    assert.equal(ignition.polarity, "contradicts");
    assert.equal(fuel.polarity, "contradicts");
  });
});
