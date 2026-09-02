import { searchBing } from "../browser/bing.js";
import type { SearchResult } from "../types/search.js";

// Search the web for a diagnostic query and return organic result sources.
export async function search(query: string): Promise<SearchResult[]> {
  try {
    return await searchBing(query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`AutoTrace research failed:\nQuery: ${query}\nReason: ${reason}`);
  }
}
