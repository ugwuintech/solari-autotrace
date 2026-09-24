// How an extracted finding relates to the diagnostic query at extraction time.
// Extraction currently tags findings as context; hypothesis-level support/contradiction
// is classified later as mention polarity on the hypothesis board.
export type EvidenceRelevance = "supports" | "contradicts" | "context";

// Information taken from a source page, kept separate from generated reasoning.
export type Evidence = {
  title: string;
  url: string;
  finding: string;
  relevance: EvidenceRelevance;
};
