import { Solari, type LaunchOptions } from "@solarisdk/browser";
import type { Page } from "patchright-core";
import type { SearchBlock, SearchOutcome, SearchQueryResults, SearchResult } from "../types/search.js";

const ENGINE_NAME = "duckduckgo";
const RESULT_SELECTOR = "a[data-testid='result-title-a']";
const AD_CONTAINER_SELECTOR = "[data-testid='ad'], [data-layout='ad'], .badge--ad, .result--ad";
const MORE_RESULTS_SELECTOR = "#more-results";
const RESULT_WAIT_TIMEOUT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 25000;
const MORE_RESULTS_TIMEOUT_MS = 4000;
const QUERY_PAUSE_MS = 1500;

/**
 * A plain datacenter session gets an empty DuckDuckGo result page, so the stealth shim plus
 * residential egress are required (`proxy` requires `stealth`). Captcha solving is not needed:
 * DuckDuckGo serves normal results through this configuration.
 */
const DUCKDUCKGO_LAUNCH_OPTIONS: LaunchOptions = {
  stealth: true,
  proxy: "us",
};

// DuckDuckGo's own surfaces are navigation, not research sources.
const DUCKDUCKGO_NAVIGATION_HOSTS = ["duckduckgo.com", "duck.com", "spreadprivacy.com"];

// Text shown when DuckDuckGo rate-limits or challenges the session.
const BLOCK_TEXT_PATTERNS = [
  "unfortunately, bots use duckduckgo too",
  "anomaly in your search",
  "if this error persists",
];

// DuckDuckGo wraps some links as /l/?uddg=<encoded destination>. Return the destination.
function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const parsed = new URL(href);
    if (!parsed.pathname.startsWith("/l/")) {
      return href;
    }

    const destination = parsed.searchParams.get("uddg");
    if (destination && destination.startsWith("http")) {
      return destination;
    }
    return href;
  } catch {
    return href;
  }
}

// True when the URL points back at DuckDuckGo rather than at a source page.
function isNavigationUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return DUCKDUCKGO_NAVIGATION_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return true;
  }
}

/**
 * Detect a DuckDuckGo rate-limit or challenge page.
 * Returns a human-readable reason, or null when the page looks like a normal result page.
 */
async function detectBlock(page: Page): Promise<string | null> {
  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  const matched = BLOCK_TEXT_PATTERNS.find((pattern) => bodyText.includes(pattern));
  if (matched) {
    return `DuckDuckGo served a rate-limit or challenge page mentioning "${matched}"`;
  }

  if (await page.locator("iframe[src*='captcha'], form[action*='captcha']").count()) {
    return "DuckDuckGo presented a CAPTCHA challenge";
  }

  return null;
}

/**
 * Ask for the second batch of results. DuckDuckGo paginates by button rather than by URL offset,
 * so a missing button simply means the first batch is all there is.
 */
async function loadMoreResults(page: Page): Promise<void> {
  try {
    const button = page.locator(MORE_RESULTS_SELECTOR);
    await button.waitFor({ timeout: MORE_RESULTS_TIMEOUT_MS });
    await button.click({ timeout: MORE_RESULTS_TIMEOUT_MS });
    await page.waitForTimeout(MORE_RESULTS_TIMEOUT_MS);
  } catch {
    // Only one batch of results is available for this query.
  }
}

// Read the title and destination of each organic result, skipping ad containers.
async function extractOrganicResults(page: Page): Promise<SearchResult[]> {
  const resultLocator = page.locator(RESULT_SELECTOR);
  try {
    await resultLocator.first().waitFor({ timeout: RESULT_WAIT_TIMEOUT_MS });
  } catch {
    // No organic results rendered — the caller reports the empty page instead of hanging.
    return [];
  }

  await loadMoreResults(page);

  return resultLocator.evaluateAll(
    (anchors, adSelector) =>
      anchors
        .map((anchor) => anchor as HTMLAnchorElement)
        .filter((link) => link.closest(adSelector) === null)
        .map((link) => ({
          title: link.textContent?.trim() ?? "",
          url: link.href,
        })),
    AD_CONTAINER_SELECTOR
  );
}

// Drop empty titles, DuckDuckGo navigation links, and duplicate destinations.
function cleanResults(results: SearchResult[]): SearchResult[] {
  const seenUrls = new Set<string>();
  const cleaned: SearchResult[] = [];
  for (const result of results) {
    const url = unwrapDuckDuckGoUrl(result.url);
    if (!result.title || !url.startsWith("http") || seenUrls.has(url) || isNavigationUrl(url)) {
      continue;
    }
    seenUrls.add(url);
    cleaned.push({ title: result.title, url });
  }
  return cleaned;
}

// Pause briefly between searches so successive queries are less bursty.
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type QueryOutcome = {
  results: SearchResult[];
  blockReason: string | null;
};

// Run one DuckDuckGo search and return its organic results.
async function searchOneQuery(page: Page, query: string): Promise<QueryOutcome> {
  await page.goto(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web&kl=us-en`,
    { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }
  );

  const blockReason = await detectBlock(page);
  if (blockReason) {
    return { results: [], blockReason };
  }

  const results = cleanResults(await extractOrganicResults(page));
  if (results.length === 0) {
    console.log(`No DuckDuckGo results for query: ${query}`);
    console.log(`SERP title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);
  } else {
    console.log(`SERP title: ${await page.title()}`);
    console.log(`First result: ${results[0]?.title ?? ""}`);
  }

  return { results, blockReason: null };
}

// Record what the engine actually showed so a block is traceable rather than silent.
async function describeBlock(page: Page, query: string, reason: string): Promise<SearchBlock> {
  return {
    query,
    reason,
    pageTitle: await page.title(),
    pageUrl: page.url(),
  };
}

/**
 * Launch a Solari browser, search DuckDuckGo for each query, and return organic results per query.
 * Searching stops at the first block: AutoTrace reports the block rather than retrying around it.
 */
export async function searchDuckDuckGoQueries(queries: string[]): Promise<SearchOutcome> {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is not set");
  }

  const solari = new Solari({
    apiKey,
  });

  const browser = await solari.launch(DUCKDUCKGO_LAUNCH_OPTIONS);

  try {
    const page = await browser.newPage();
    const batches: SearchQueryResults[] = [];
    const blocks: SearchBlock[] = [];

    for (const query of queries) {
      console.log(`Searching DuckDuckGo: ${query}`);
      let outcome: QueryOutcome;
      try {
        outcome = await searchOneQuery(page, query);
      } catch (error: unknown) {
        // Navigation/search failure for one query: record as a block and stop remaining queries.
        const reason = error instanceof Error ? error.message : String(error);
        outcome = {
          results: [],
          blockReason: `DuckDuckGo search navigation failed for this query: ${reason}`,
        };
      }
      batches.push({ query, results: outcome.results });

      if (outcome.blockReason) {
        let block: SearchBlock;
        try {
          block = await describeBlock(page, query, outcome.blockReason);
        } catch {
          block = {
            query,
            reason: outcome.blockReason,
            pageTitle: "",
            pageUrl: "",
          };
        }
        blocks.push(block);
        console.log(`DuckDuckGo blocked this session: ${block.reason}`);
        console.log("Stopping search; remaining queries were not run.\n");
        break;
      }

      await pause(QUERY_PAUSE_MS);
    }

    return { engine: ENGINE_NAME, batches, blocks };
  } finally {
    await browser.close();
    // Required: the client keeps a loopback proxy open that holds the process alive.
    await solari.close();
  }
}
