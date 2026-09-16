import { Solari, type LaunchOptions } from "@solarisdk/browser";
import type { Page } from "patchright-core";
import type { PageContent } from "../types/pageContent.js";
import type { SearchResult } from "../types/search.js";

const PAGE_TIMEOUT_MS = 20000;
const BODY_TIMEOUT_MS = 10000;

// Below this, a container is treated as a stub and the next selector is tried.
const MIN_CONTENT_LENGTH = 200;

/**
 * Containers that hold the readable content of a source page, most specific first.
 * The vBulletin post-body selector is the one the visited automotive forums actually use; the
 * remaining entries cover other common forum and article layouts. Selectors are confined to this
 * layer, so a layout change is fixed here without touching research or reasoning code.
 */
const CONTENT_SELECTORS = [
  "div[id^='post_message_']",
  ".bbWrapper",
  ".postbody",
  "[itemprop='articleBody']",
  "article",
  "main",
];

/**
 * Automotive forums and code-reference sites return empty or challenge pages to datacenter
 * traffic, so source visits use the same stealth plus residential egress as the search step.
 */
const SOURCE_LAUNCH_OPTIONS: LaunchOptions = {
  stealth: true,
  proxy: "us",
};

// Page text with the selector that produced it, so extraction quality stays inspectable.
type ExtractedText = {
  text: string;
  selector: string;
};

/**
 * Read text from the first content container that yields a usable amount of text.
 * Forum threads keep the technician discussion inside post bodies, so reading the whole document
 * returns navigation and thread furniture instead of the discussion.
 */
async function readContentText(page: Page): Promise<ExtractedText | null> {
  return page.evaluate(
    ({ selectors, minLength }: { selectors: string[]; minLength: number }) => {
      for (const selector of selectors) {
        const blocks = Array.from(document.querySelectorAll(selector))
          .map((node) => (node instanceof HTMLElement ? node.innerText : node.textContent ?? ""))
          .map((text) => text.trim())
          .filter((text) => text.length > 0);

        const text = blocks.join("\n\n").trim();
        if (text.length >= minLength) {
          return { text, selector };
        }
      }

      return null;
    },
    { selectors: CONTENT_SELECTORS, minLength: MIN_CONTENT_LENGTH }
  );
}

// Read content text after navigation, falling back to the whole page. Evidence keeps the search-result title.
async function readPageContent(page: Page, source: SearchResult): Promise<PageContent | null> {
  await page.goto(source.url, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });

  const liveTitle = (await page.title()).trim();
  const content = await readContentText(page);
  const text = content
    ? content.text
    : (await page.locator("body").innerText({ timeout: BODY_TIMEOUT_MS })).trim();
  console.log(`Content read from: ${content ? content.selector : "whole page (no content container matched)"}`);

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
