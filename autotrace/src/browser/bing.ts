import { Solari } from "@solarisdk/browser";
import type { Page } from "patchright-core";
import type { SearchQueryResults, SearchResult } from "../types/search.js";

const BING_RESULT_SELECTOR = "li.b_algo h2 a";
const RESULT_WAIT_TIMEOUT_MS = 15000;
const BING_RESULT_OFFSETS = [1, 11];
const QUERY_PAUSE_MS = 1000;

// Decode a Bing /ck/a tracking URL into the destination address.
function unwrapBingUrl(href: string): string {
  try {
    const encoded = new URL(href).searchParams.get("u");
    if (!encoded) {
      return href;
    }

    const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (decoded.startsWith("http")) {
      return decoded;
    }
    return href;
  } catch {
    return href;
  }
}

// Wait for organic Bing results, then read the title and href from each result link.
async function extractOrganicResults(page: Page): Promise<SearchResult[]> {
  const resultLocator = page.locator(BING_RESULT_SELECTOR);
  try {
    await resultLocator.first().waitFor({ timeout: RESULT_WAIT_TIMEOUT_MS });
  } catch {
    // Empty page or block — report below instead of hanging.
  }

  return resultLocator.evaluateAll((anchors) =>
    anchors.map((anchor) => {
      const link = anchor as HTMLAnchorElement;
      return {
        title: link.textContent?.trim() ?? "",
        url: link.href,
      };
    })
  );
}

// Drop empty titles, non-http URLs, and duplicate destinations after unwrapping Bing tracking links.
function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seenUrls = new Set<string>();
  const uniqueResults: SearchResult[] = [];
  for (const result of results) {
    const url = unwrapBingUrl(result.url);
    if (!result.title || !url.startsWith("http") || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    uniqueResults.push({ title: result.title, url });
  }
  return uniqueResults;
}

// Pause briefly between Bing page loads so successive queries are less bursty.
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load one Bing results page for a query.
async function loadBingResultsPage(page: Page, query: string, first: number): Promise<SearchResult[]> {
  // Bing works on the free plan. Google and DuckDuckGo need paid stealth/captcha.
  await page.goto(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}`,
    { waitUntil: "domcontentloaded" }
  );

  const results = await extractOrganicResults(page);
  if (results.length === 0) {
    console.log(`No Bing results at offset ${first} for query: ${query}`);
    console.log(`Bing SERP title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);
  } else if (first === 1) {
    console.log(`Bing SERP title: ${await page.title()}`);
    console.log(`First result: ${results[0]?.title ?? ""}`);
  }

  return results;
}

// Run one Bing search across a small number of result pages and return organic results.
async function searchOneQuery(page: Page, query: string): Promise<SearchResult[]> {
  const combined: SearchResult[] = [];
  for (const [index, first] of BING_RESULT_OFFSETS.entries()) {
    if (index > 0) {
      await pause(QUERY_PAUSE_MS);
    }
    const pageResults = await loadBingResultsPage(page, query, first);
    combined.push(...pageResults);
  }
  return deduplicateResults(combined);
}

// Launch a Solari browser, search Bing for each query, and return organic results per query.
export async function searchBingQueries(queries: string[]): Promise<SearchQueryResults[]> {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is not set");
  }

  const solari = new Solari({
    apiKey,
  });

  const browser = await solari.launch();

  try {
    const page = await browser.newPage();
    const batches: SearchQueryResults[] = [];

    for (const query of queries) {
      console.log(`Searching Bing: ${query}`);
      const results = await searchOneQuery(page, query);
      batches.push({ query, results });
      await pause(QUERY_PAUSE_MS);
    }

    return batches;
  } finally {
    await browser.close();
    // Required: the client keeps a loopback proxy open that holds the process alive.
    await solari.close();
  }
}
