import { Solari, type LaunchOptions } from "@solarisdk/browser";
import type { Page } from "patchright-core";
import type { SearchBlock, SearchOutcome, SearchQueryResults, SearchResult } from "../types/search.js";

const ENGINE_NAME = "google";

/**
 * Google serves its /sorry/ interstitial to datacenter, residential, and mobile egress alike,
 * so the search path needs the full Solari configuration: the stealth shim, residential egress,
 * and managed captcha solving. `proxy` and `captcha` both require `stealth`.
 */
const GOOGLE_LAUNCH_OPTIONS: LaunchOptions = {
  stealth: true,
  proxy: "us",
  captcha: true,
};
const GOOGLE_RESULT_SELECTOR = "#search a:has(h3)";
const GOOGLE_AD_CONTAINER_SELECTOR = "#tads, #bottomads, #tvcap, [data-text-ad], [aria-label='Ads']";
const RESULT_WAIT_TIMEOUT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 25000;
const CHALLENGE_CLEAR_TIMEOUT_MS = 45000;
const GOOGLE_RESULT_OFFSETS = [0, 10];
const QUERY_PAUSE_MS = 1500;

// Google's own surfaces: account, help, policy, and cache links are navigation, not research sources.
const GOOGLE_NAVIGATION_HOSTS = [
  "google.com",
  "google.co.uk",
  "googleusercontent.com",
  "gstatic.com",
  "googleadservices.com",
  "doubleclick.net",
];

// Text that appears on Google's interstitial, consent, and rate-limit pages.
// The /sorry/ interstitial is matched by URL instead, since its title is unreliable.
const BLOCK_TITLE_PATTERNS = [
  "unusual traffic",
  "before you continue",
  "are you a robot",
];

// Google wraps some results in /url?q=<destination>. Return the destination when present.
function unwrapGoogleUrl(href: string): string {
  try {
    const parsed = new URL(href);
    if (!parsed.pathname.startsWith("/url")) {
      return href;
    }

    const destination = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
    if (destination && destination.startsWith("http")) {
      return destination;
    }
    return href;
  } catch {
    return href;
  }
}

// True when the URL points back at Google or an ad-serving domain rather than a source page.
function isNavigationOrAdUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return GOOGLE_NAVIGATION_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return true;
  }
}

/**
 * Detect a Google block, consent wall, or CAPTCHA challenge.
 * Returns a human-readable reason, or null when the page looks like a normal result page.
 * AutoTrace reports these instead of attempting to defeat them.
 */
async function detectBlock(page: Page): Promise<string | null> {
  const url = page.url().toLowerCase();
  if (url.includes("/sorry/")) {
    return "Google served its /sorry/ interstitial (automated-traffic block)";
  }
  if (url.includes("consent.google.com")) {
    return "Google redirected to a consent wall before showing results";
  }

  const title = (await page.title()).toLowerCase();
  if (BLOCK_TITLE_PATTERNS.some((pattern) => title.includes(pattern))) {
    return `Google returned a challenge page titled "${title}"`;
  }

  const captchaCount = await page.locator("form#captcha-form, iframe[src*='recaptcha']").count();
  if (captchaCount > 0) {
    return "Google presented a CAPTCHA challenge";
  }

  return null;
}

/**
 * Solari's managed solver clears the interstitial in the background, so give it one bounded
 * window to hand the session back to the results page. Returns false when the window expires;
 * the caller then reports the block rather than retrying.
 */
async function waitForChallengeToClear(page: Page): Promise<boolean> {
  try {
    await page.waitForURL((url) => !url.pathname.startsWith("/sorry"), {
      timeout: CHALLENGE_CLEAR_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// Read the title and destination of each organic result, skipping ad containers.
async function extractOrganicResults(page: Page): Promise<SearchResult[]> {
  const resultLocator = page.locator(GOOGLE_RESULT_SELECTOR);
  try {
    await resultLocator.first().waitFor({ timeout: RESULT_WAIT_TIMEOUT_MS });
  } catch {
    // No organic results rendered — the caller reports the empty page instead of hanging.
    return [];
  }

  return resultLocator.evaluateAll(
    (anchors, adSelector) =>
      anchors
        .map((anchor) => anchor as HTMLAnchorElement)
        .filter((link) => link.closest(adSelector) === null)
        .map((link) => ({
          title: link.querySelector("h3")?.textContent?.trim() ?? "",
          url: link.href,
        })),
    GOOGLE_AD_CONTAINER_SELECTOR
  );
}

// Drop empty titles, Google navigation/ad links, and duplicate destinations.
function cleanResults(results: SearchResult[]): SearchResult[] {
  const seenUrls = new Set<string>();
  const cleaned: SearchResult[] = [];
  for (const result of results) {
    const url = unwrapGoogleUrl(result.url);
    if (!result.title || !url.startsWith("http") || seenUrls.has(url) || isNavigationOrAdUrl(url)) {
      continue;
    }
    seenUrls.add(url);
    cleaned.push({ title: result.title, url });
  }
  return cleaned;
}

// Pause briefly between Google page loads so successive queries are less bursty.
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ResultsPage = {
  results: SearchResult[];
  blockReason: string | null;
};

// Load one Google results page for a query, reporting a block instead of returning fake results.
async function loadGoogleResultsPage(page: Page, query: string, start: number): Promise<ResultsPage> {
  await page.goto(
    `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&start=${start}`,
    { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }
  );

  let blockReason = await detectBlock(page);
  if (blockReason) {
    console.log(`Google challenge detected; waiting for Solari's managed solver...`);
    const cleared = await waitForChallengeToClear(page);
    blockReason = cleared ? await detectBlock(page) : blockReason;
  }
  if (blockReason) {
    return { results: [], blockReason };
  }

  const results = await extractOrganicResults(page);
  if (results.length === 0) {
    console.log(`No Google results at offset ${start} for query: ${query}`);
    console.log(`Google SERP title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);
  } else if (start === 0) {
    console.log(`Google SERP title: ${await page.title()}`);
    console.log(`First result: ${results[0]?.title ?? ""}`);
  }

  return { results, blockReason: null };
}

// Run one Google search across a small number of result pages.
async function searchOneQuery(page: Page, query: string): Promise<ResultsPage> {
  const combined: SearchResult[] = [];
  for (const [index, start] of GOOGLE_RESULT_OFFSETS.entries()) {
    if (index > 0) {
      await pause(QUERY_PAUSE_MS);
    }

    const pageResults = await loadGoogleResultsPage(page, query, start);
    if (pageResults.blockReason) {
      return { results: cleanResults(combined), blockReason: pageResults.blockReason };
    }
    combined.push(...pageResults.results);
  }

  return { results: cleanResults(combined), blockReason: null };
}

// Record what Google actually showed so a block is traceable rather than silent.
async function describeBlock(page: Page, query: string, reason: string): Promise<SearchBlock> {
  return {
    query,
    reason,
    pageTitle: await page.title(),
    pageUrl: page.url(),
  };
}

/**
 * Launch a Solari browser, search Google for each query, and return organic results per query.
 * Searching stops at the first block: AutoTrace reports the block rather than retrying around it.
 */
export async function searchGoogleQueries(queries: string[]): Promise<SearchOutcome> {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is not set");
  }

  const solari = new Solari({
    apiKey,
  });

  const browser = await solari.launch(GOOGLE_LAUNCH_OPTIONS);

  try {
    const page = await browser.newPage();
    const batches: SearchQueryResults[] = [];
    const blocks: SearchBlock[] = [];

    for (const query of queries) {
      console.log(`Searching Google: ${query}`);
      const outcome = await searchOneQuery(page, query);
      batches.push({ query, results: outcome.results });

      if (outcome.blockReason) {
        const block = await describeBlock(page, query, outcome.blockReason);
        blocks.push(block);
        console.log(`Google blocked this session: ${block.reason}`);
        console.log("Stopping Google search; remaining queries were not run.\n");
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
