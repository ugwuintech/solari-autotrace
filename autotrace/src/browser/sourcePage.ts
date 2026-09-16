import { Solari, type LaunchOptions } from "@solarisdk/browser";
import type { Page } from "patchright-core";
import type { PageContent } from "../types/pageContent.js";
import type { SearchResult } from "../types/search.js";

const PAGE_TIMEOUT_MS = 20000;
const BODY_TIMEOUT_MS = 10000;

/**
 * Automotive forums and code-reference sites return empty or challenge pages to datacenter
 * traffic, so source visits use the same stealth plus residential egress as the search step.
 */
const SOURCE_LAUNCH_OPTIONS: LaunchOptions = {
  stealth: true,
  proxy: "us",
};

// Read visible body text after navigation. Evidence keeps the original search-result title.
async function readPageContent(page: Page, source: SearchResult): Promise<PageContent | null> {
  await page.goto(source.url, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });

  const liveTitle = (await page.title()).trim();
  const text = (await page.locator("body").innerText({ timeout: BODY_TIMEOUT_MS })).trim();
  if (!text) {
    console.log(`Source page returned no readable text:\nURL: ${source.url}\n`);
    return null;
  }

  return {
    url: source.url,
    title: source.title || liveTitle,
    text,
  };
}

// Visit one source and extract page content. A failure returns null instead of throwing.
async function extractOneSource(page: Page, source: SearchResult): Promise<PageContent | null> {
  try {
    console.log(`Visiting source: ${source.url}`);
    return await readPageContent(page, source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`AutoTrace source extraction failed:\nURL: ${source.url}\nReason: ${reason}\n`);
    return null;
  }
}

// Launch a Solari browser, visit each source page, and return usable page content.
export async function extractSourcePages(sources: SearchResult[]): Promise<PageContent[]> {
  if (sources.length === 0) {
    return [];
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is not set");
  }

  const solari = new Solari({
    apiKey,
  });

  const browser = await solari.launch(SOURCE_LAUNCH_OPTIONS);

  try {
    const page = await browser.newPage();
    const pages: PageContent[] = [];

    for (const source of sources) {
      const content = await extractOneSource(page, source);
      if (content) {
        pages.push(content);
      }
    }

    return pages;
  } finally {
    await browser.close();
    await solari.close();
  }
}
