// How an extracted finding relates to the diagnostic query.
// supports/contradicts are reserved for later hypothesis evaluation.
export type EvidenceRelevance = "supports" | "contradicts" | "context";

// Information taken from a source page, kept separate from generated reasoning.
export type Evidence = {
  title: string;
  url: string;
  finding: string;
  relevance: EvidenceRelevance;
};
