import { searchDuckDuckGoQueries } from "../browser/duckduckgo.js";
import type { SearchOutcome } from "../types/search.js";

/**
 * Search for each diagnostic query and return organic results grouped by query.
 * DuckDuckGo is the primary engine: Google serves its /sorry/ interstitial to every Solari
 * configuration tried, including stealth, residential/mobile egress, and managed captcha solving.
 * google.ts and bing.ts are kept as reference implementations.
 */
export async function search(queries: string[]): Promise<SearchOutcome> {
  try {
    return await searchDuckDuckGoQueries(queries);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `AutoTrace research failed:\nQueries: ${queries.join(" | ")}\nReason: ${reason}`
    );
  }
}
