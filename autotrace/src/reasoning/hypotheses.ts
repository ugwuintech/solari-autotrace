import { matchedTerms } from "../research/terms.js";
import type { Evidence } from "../types/evidence.js";
import type {
  Hypothesis,
  HypothesisBoard,
  HypothesisEvidence,
  HypothesisMention,
} from "../types/hypothesis.js";
import type { TermGroup } from "../types/terms.js";
import { classifyMentionPolarity } from "./evaluateEvidence.js";

// A hypothesis plus the terms that link source text to it. The terms are matching rules, not claims.
type HypothesisDefinition = Hypothesis & {
  evidenceTerms: TermGroup[];
};

/**
 * The competing explanation families for a misfire-centred investigation.
 * They are the starting set of explanations to investigate, derived from the scope of the case and
 * not from any evidence, so no entry here asserts a cause. Evidence decides which families become
 * more or less plausible, and hypothesis generation moves to the reasoning layer in a later phase.
 */
const HYPOTHESIS_DEFINITIONS: HypothesisDefinition[] = [
  {
    id: "H1",
    label: "Ignition-related misfire",
    claim: "A fault in the ignition path of the affected cylinder could produce the reported misfire.",
    possibleCauses: [
      "failed or intermittent ignition coil",
      "worn, fouled, or cracked spark plug",
      "damaged coil boot, plug connector, or secondary insulation",
    ],
    evidenceTerms: [
      { label: "ignition", terms: ["ignition", "spark", "misfire ignition"] },
      { label: "coil", terms: ["coil", "coils", "ignition coil", "coil pack", "coil boot"] },
      { label: "spark plug", terms: ["spark plug", "spark plugs", "plug wire", "plug wires", "plug gap"] },
    ],
  },
  {
    id: "H2",
    label: "Fuel delivery problem",
    claim: "Insufficient, excessive, or poorly atomised fuel delivery to the affected cylinder could produce the reported misfire.",
    possibleCauses: [
      "clogged, leaking, or electrically failed injector",
      "low or uneven fuel pressure",
      "fuel supply restriction affecting one cylinder",
    ],
    evidenceTerms: [
      { label: "injector", terms: ["injector", "injectors", "fuel injector", "injector coil"] },
      { label: "fuel supply", terms: ["fuel pressure", "fuel pump", "fuel filter", "fuel rail", "fuel delivery"] },
      { label: "mixture", terms: ["fuel trim", "air fuel ratio", "lean", "rich", "lambda"] },
    ],
  },
  {
    id: "H3",
    label: "Mechanical/compression problem",
    claim: "A mechanical defect in the affected cylinder could prevent normal combustion and produce the reported misfire.",
    possibleCauses: [
      "low compression in the affected cylinder",
      "valve, valve seat, or valve seal damage",
      "head gasket, piston, or timing-related mechanical fault",
    ],
    evidenceTerms: [
      { label: "compression", terms: ["compression", "compression test", "leak down", "leakdown", "leak-down"] },
      // Bare "valve" is excluded: it also names air-management parts such as the EGR valve.
      {
        label: "valvetrain",
        terms: ["valve seal", "valve guide", "valve seat", "valve train", "valvetrain", "camshaft", "timing chain"],
      },
      { label: "engine mechanical", terms: ["head gasket", "piston", "cylinder head", "bent valve", "burnt valve"] },
    ],
  },
  {
    id: "H4",
    label: "Air-management/EGR-related problem",
    claim: "Unmetered air, restricted airflow, or exhaust gas recirculation behaviour could disturb combustion and produce the reported codes.",
    possibleCauses: [
      "EGR valve or EGR passage fault",
      "vacuum or intake air leak",
      "intake manifold, air-flow sensing, or air-management actuator fault",
    ],
    evidenceTerms: [
      { label: "egr", terms: ["egr", "egr valve", "exhaust gas recirculation"] },
      { label: "intake air", terms: ["intake", "intake manifold", "air management", "unmetered air", "intake air"] },
      { label: "leak/airflow", terms: ["vacuum leak", "air leak", "maf", "mass air flow", "air flow sensor"] },
    ],
  },
  {
    id: "H5",
    label: "Electrical/wiring problem",
    claim: "A wiring, connector, or ground fault in the affected circuit could produce the reported codes without the named component having failed.",
    possibleCauses: [
      "chafed, broken, or shorted wiring",
      "corroded or loose connector, or poor ground",
      "harness or control-module circuit fault affecting the reported system",
    ],
    evidenceTerms: [
      // Bare "wire"/"wires" is excluded: on ignition discussions it usually means plug wires.
      { label: "wiring", terms: ["wiring", "wiring harness", "harness", "loom"] },
      { label: "connection", terms: ["connector", "connectors", "terminal", "corrosion", "ground"] },
      { label: "circuit", terms: ["short circuit", "open circuit", "continuity", "resistance", "circuit fault", "voltage drop"] },
    ],
  },
];

// Strip the matching rules so callers receive the hypothesis itself.
function toHypothesis(definition: HypothesisDefinition): Hypothesis {
  const { id, label, claim, possibleCauses } = definition;
  return { id, label, claim, possibleCauses };
}

// The competing explanations for the case, before any evidence is considered.
export function buildHypotheses(): Hypothesis[] {
  return HYPOTHESIS_DEFINITIONS.map(toHypothesis);
}

// Evidence whose title or finding mentions this hypothesis' system, with matched terms and polarity.
function mentionsOf(definition: HypothesisDefinition, evidence: Evidence[]): HypothesisMention[] {
  const mentions: HypothesisMention[] = [];

  for (const item of evidence) {
    const haystack = `${item.title} ${item.finding}`.toLowerCase();
    const matched = matchedTerms(haystack, definition.evidenceTerms);
    if (matched.length > 0) {
      const classified = classifyMentionPolarity(haystack, matched);
      mentions.push({
        evidence: item,
        matchedTerms: matched,
        polarity: classified.polarity,
        polarityReason: classified.reason,
      });
    }
  }

  return mentions;
}

/**
 * Attach collected evidence to every hypothesis whose system it mentions.
 * Matching is deterministic and term-based, so one source can mention several hypotheses and
 * evidence that mentions none is reported rather than dropped. Each mention also receives a
 * polarity classification (context / supports / contradicts); this is still not a final diagnosis.
 */
export function buildHypothesisBoard(evidence: Evidence[]): HypothesisBoard {
  const hypotheses: HypothesisEvidence[] = HYPOTHESIS_DEFINITIONS.map((definition) => ({
    hypothesis: toHypothesis(definition),
    mentions: mentionsOf(definition, evidence),
  }));

  const mentionedUrls = new Set(
    hypotheses.flatMap((entry) => entry.mentions.map((mention) => mention.evidence.url))
  );
  const unmentionedEvidence = evidence.filter((item) => !mentionedUrls.has(item.url));

  return { hypotheses, unmentionedEvidence };
}
