import { span, trace } from "neatlogs";
import { extractSourcePages } from "../browser/sourcePage.js";
import { reportProgress } from "../observability/progress.js";
import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { Evidence } from "../types/evidence.js";
import type { PageContent } from "../types/pageContent.js";
import type { RecoveryEvent, RecoveryRecorder } from "../types/recovery.js";
import type { CandidateRejection } from "../types/rejection.js";
import type { SearchBlock, SearchOutcome, SearchResult } from "../types/search.js";
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

// OpenTelemetry's SpanStatusCode.ERROR, used directly to avoid depending on @opentelemetry/api.
const SPAN_STATUS_ERROR = 2;

// Neatlogs spans for each research step. Page text is never captured, only what was found or lost.

// Search, and mark the span failed when a block stopped it, so a truncated search is never silent.
function tracedSearch(queries: string[]): Promise<SearchOutcome> {
  return trace({ name: "web_search", kind: "TOOL", input: queries }, async (activeSpan) => {
    const outcome = await search(queries);
    activeSpan.setAttribute("output.value", JSON.stringify(outcome));
    activeSpan.setAttribute("autotrace.search.blocks", outcome.blocks.length);
    const block = outcome.blocks[0];
    if (block) {
      activeSpan.setStatus({
        code: SPAN_STATUS_ERROR,
        message: `search stopped after "${block.query}": ${block.reason}`,
      });
    }
    return outcome;
  });
}
const tracedExtractEvidence = span(
  { kind: "CHAIN", name: "extract_evidence", captureInput: false },
  extractEvidence
);

// Visit the selected sources in Solari and record which pages were read and which were lost.
function tracedExtractSourcePages(
  sources: SearchResult[],
  onRecovery: RecoveryRecorder
): Promise<PageContent[]> {
  return trace(
    { name: "extract_source_pages", kind: "TOOL", input: sources.map((source) => source.url) },
    async (activeSpan) => {
      const pages = await extractSourcePages(sources, onRecovery);
      const extracted = new Set(pages.map((page) => page.url));
      activeSpan.setAttribute("autotrace.pages.requested", sources.length);
      activeSpan.setAttribute("autotrace.pages.extracted", pages.length);
      activeSpan.setAttribute(
        "output.value",
        JSON.stringify({
          extracted: [...extracted],
          failed: sources.map((source) => source.url).filter((url) => !extracted.has(url)),
        })
      );
      return pages;
    }
  );
}

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
  // Failed research actions that were retried successfully or recorded before stopping.
  recoveries: RecoveryEvent[];
};

/**
 * Optional overrides for a research round.
 * When queries is set and non-empty, those queries are used instead of buildResearchQueries().
 */
export type ResearchOptions = {
  queries?: string[];
};

// Resolve the query list for one research round: targeted follow-up or default case queries.
function resolveResearchQueries(
  diagnosticCase: DiagnosticCase,
  options?: ResearchOptions
): string[] {
  if (options?.queries !== undefined && options.queries.length > 0) {
    return options.queries;
  }
  return buildResearchQueries(diagnosticCase);
}

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
export async function research(
  diagnosticCase: DiagnosticCase,
  options?: ResearchOptions
): Promise<ResearchResult> {
  const queries = resolveResearchQueries(diagnosticCase, options);
  const outcome = await tracedSearch(queries);
  const batches = outcome.batches;
  const rawResults = batches.flatMap((batch) => batch.results);

  for (const batch of batches) {
    console.log(`${batch.results.length} result(s) for: ${batch.query}`);
  }
  console.log("");
  reportProgress(
    "search",
    `Search finished: ${rawResults.length} result(s) across ${batches.length} of ${queries.length} queries`
  );

  const candidateEvaluations = evaluateCandidates(rawResults, buildRankTerms(diagnosticCase));
  const uniqueCandidates = candidateEvaluations.map((item) => item.result);
  const ranked = rankCandidates(candidateEvaluations);
  const visitedCandidates = selectCandidates(ranked, MAX_SOURCE_PAGES);
  const rankedCandidates = ranked.slice(0, MAX_REPORTED_RANKED);

  const empty: ResearchResult = {
    queries,
    searchEngine: outcome.engine,
    searchBlocks: outcome.blocks,
    recoveries: outcome.recoveries ?? [],
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
    reportProgress("research", "No relevant candidate sources to visit");
    return empty;
  }

  try {
    console.log(`Collecting evidence from ${visitedCandidates.length} source page(s)...\n`);
    reportProgress(
      "research",
      `Ranked ${ranked.length} candidate source(s); visiting the top ${visitedCandidates.length}`
    );
    const extractionRecoveries: RecoveryEvent[] = [];
    const pages = await tracedExtractSourcePages(visitedCandidates, (event) => extractionRecoveries.push(event));
    const extracted = tracedExtractEvidence(pages, extraRelevanceTerms(diagnosticCase));
    const rejections = [...extractionRejections(visitedCandidates, pages), ...extracted.rejections];
    reportProgress(
      "evidence",
      `Extracted ${extracted.evidence.length} evidence item(s) from ${pages.length} of ${visitedCandidates.length} page(s)`,
      rejections.length > 0 ? `${rejections.length} source(s) set aside as unreadable or irrelevant` : undefined
    );

    return {
      queries,
      searchEngine: outcome.engine,
      searchBlocks: outcome.blocks,
      recoveries: [...(outcome.recoveries ?? []), ...extractionRecoveries],
      rawResultCount: rawResults.length,
      uniqueCandidateCount: uniqueCandidates.length,
      rankedCandidateCount: ranked.length,
      candidatesVisited: visitedCandidates.length,
      candidatesRejectedAsIrrelevant: extracted.rejections.length,
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
