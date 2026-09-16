import { extractSourcePages } from "../browser/sourcePage.js";
import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type { CandidateRejection } from "../types/rejection.js";
import type { SearchBlock, SearchResult } from "../types/search.js";
import { extractEvidence } from "./extract.js";
import { buildResearchQueries } from "./queries.js";
import {
  buildRankTerms,
  evaluateCandidates,
  rankCandidates,
  selectCandidates,
  type CandidateEvaluation,
} from "./rank.js";
import { search } from "./search.js";

const MAX_SOURCE_PAGES = 4;

// How many ranked candidates are reported, so the ranking behind the visit set stays inspectable.
const MAX_REPORTED_RANKED = 8;

export type ResearchResult = {
  queries: string[];
  searchEngine: string;
  searchBlocks: SearchBlock[];
  rawResultCount: number;
  uniqueCandidateCount: number;
  rankedCandidateCount: number;
  candidatesVisited: number;
  candidatesRejectedAsIrrelevant: number;
  rankedCandidates: CandidateEvaluation[];
  visitedCandidates: SearchResult[];
  candidateEvaluations: CandidateEvaluation[];
  searchResults: SearchResult[];
  evidence: Evidence[];
  rejections: CandidateRejection[];
};

// Extra DTC tokens for the page-text relevance gate.
function extraRelevanceTerms(diagnosticCase: DiagnosticCase): string[] {
  return diagnosticCase.codes
    .map((item) => item.code.toLowerCase())
    .filter((code) => code.length > 0);
}

// Mark selected sources whose page could not be fetched.
function extractionRejections(
  sources: SearchResult[],
  pages: { url: string }[]
): CandidateRejection[] {
  const extractedUrls = new Set(pages.map((page) => page.url));
  return sources
    .filter((source) => !extractedUrls.has(source.url))
    .map((source) => ({
      title: source.title,
      url: source.url,
      reason: "page extraction failed",
    }));
}

// Search with several queries, rank unique sources, visit a few, and extract evidence.
export async function research(diagnosticCase: DiagnosticCase): Promise<ResearchResult> {
  const queries = buildResearchQueries(diagnosticCase);
  const outcome = await search(queries);
  const batches = outcome.batches;
  const rawResults = batches.flatMap((batch) => batch.results);

  for (const batch of batches) {
    console.log(`${batch.results.length} result(s) for: ${batch.query}`);
  }
  console.log("");

  const candidateEvaluations = evaluateCandidates(rawResults, buildRankTerms(diagnosticCase));
  const uniqueCandidates = candidateEvaluations.map((item) => item.result);
  const ranked = rankCandidates(candidateEvaluations);
  const visitedCandidates = selectCandidates(ranked, MAX_SOURCE_PAGES);
  const rankedCandidates = ranked.slice(0, MAX_REPORTED_RANKED);

  const empty: ResearchResult = {
    queries,
    searchEngine: outcome.engine,
    searchBlocks: outcome.blocks,
    rawResultCount: rawResults.length,
    uniqueCandidateCount: uniqueCandidates.length,
    rankedCandidateCount: ranked.length,
    candidatesVisited: 0,
    candidatesRejectedAsIrrelevant: 0,
    rankedCandidates,
    visitedCandidates,
    candidateEvaluations,
    searchResults: uniqueCandidates,
    evidence: [],
    rejections: [],
  };

  if (visitedCandidates.length === 0) {
    return empty;
  }

  try {
    console.log(`Collecting evidence from ${visitedCandidates.length} source page(s)...\n`);
    const pages = await extractSourcePages(visitedCandidates);
    const extracted = extractEvidence(pages, extraRelevanceTerms(diagnosticCase));
    const rejections = [...extractionRejections(visitedCandidates, pages), ...extracted.rejections];

    return {
      queries,
      searchEngine: outcome.engine,
      searchBlocks: outcome.blocks,
      rawResultCount: rawResults.length,
      uniqueCandidateCount: uniqueCandidates.length,
      rankedCandidateCount: ranked.length,
      candidatesVisited: visitedCandidates.length,
      candidatesRejectedAsIrrelevant: rejections.length,
      rankedCandidates,
      visitedCandidates,
      candidateEvaluations,
      searchResults: uniqueCandidates,
      evidence: extracted.evidence,
      rejections,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `AutoTrace research failed:\nQueries: ${queries.join(" | ")}\nReason: ${reason}`
    );
  }
}
