import { Solari } from "@solarisdk/browser";
import type { Page } from "patchright-core";
import type { SearchResult } from "../types/search.js";

const BING_RESULT_SELECTOR = "li.b_algo h2 a";
const RESULT_WAIT_TIMEOUT_MS = 15000;

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

// Launch a Solari browser, search Bing for the query, and return organic results.
export async function searchBing(query: string): Promise<SearchResult[]> {
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

    // Bing works on the free plan. Google and DuckDuckGo need paid stealth/captcha.
    await page.goto(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded" }
    );

    const results = await extractOrganicResults(page);
    const uniqueResults = deduplicateResults(results);

    if (uniqueResults.length === 0) {
      console.log(`Page title: ${await page.title()}`);
      console.log(`Page URL: ${page.url()}`);
    }

    return uniqueResults;
  } finally {
    await browser.close();
    // Required: the client keeps a loopback proxy open that holds the process alive.
    await solari.close();
  }
}
