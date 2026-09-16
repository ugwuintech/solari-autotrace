import type { Evidence, EvidenceRelevance } from "../types/evidence.js";
import type { PageContent } from "../types/pageContent.js";
import type { CandidateRejection } from "../types/rejection.js";

const MIN_TEXT_LENGTH = 80;
const MIN_FINDING_LENGTH = 40;
const MAX_FINDING_LENGTH = 400;

const UNUSABLE_PREFIX_PATTERNS = [
  "access denied",
  "captcha",
  "enable javascript",
  "checking your browser",
  "please verify you are a human",
  "just a moment",
  "attention required",
  "you have been blocked",
  "sorry, you have been blocked",
];

const STRONG_RELEVANCE_TERMS = ["p0305", "misfire", "cylinder 5"];
const SUPPORTING_RELEVANCE_TERMS = [
  "diagnostic",
  "ignition",
  "injector",
  "compression",
  "fuel",
  "egr",
];

export type ExtractResult = {
  evidence: Evidence[];
  rejections: CandidateRejection[];
};

// Collapse whitespace so sentence splitting is not thrown off by page layout.
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// True when the page title indicates a block or interstitial rather than an article.
function isUnusableTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.includes("attention required") || lower.includes("access denied") || lower.includes("just a moment");
}

// True when the page text is too short or looks like a block/challenge page.
function isUnusable(text: string): boolean {
  if (text.length < MIN_TEXT_LENGTH) {
    return true;
  }

  const prefix = text.slice(0, 500).toLowerCase();
  return UNUSABLE_PREFIX_PATTERNS.some((pattern) => prefix.includes(pattern));
}

// True when haystack contains a whole term, so short tokens do not match unrelated words.
function containsTerm(haystack: string, term: string): boolean {
  const token = term.toLowerCase().trim();
  if (!token) {
    return false;
  }
  if (token.includes(" ")) {
    return haystack.includes(token);
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack);
}

// True when page text contains investigation-specific terms. This is a relevance gate, not a diagnosis.
function isRelevantToInvestigation(text: string, extraTerms: string[]): boolean {
  const haystack = text.toLowerCase();
  const requiredTerms = [...STRONG_RELEVANCE_TERMS, ...extraTerms];
  return requiredTerms.some((term) => containsTerm(haystack, term));
}

// Terms used to pick a finding from a page that already passed the relevance gate.
function findingTerms(extraTerms: string[]): string[] {
  return [...STRONG_RELEVANCE_TERMS, ...SUPPORTING_RELEVANCE_TERMS, ...extraTerms];
}

// Split normalized page text into sentences long enough to be useful findings.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_FINDING_LENGTH);
}

// Keep a finding short enough to read without copying the whole page.
function truncateFinding(text: string): string {
  if (text.length <= MAX_FINDING_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_FINDING_LENGTH).trimEnd()}...`;
}

// Take a short window of text around the first matching investigation term.
function excerptAroundTerm(text: string, terms: string[]): string | null {
  const lower = text.toLowerCase();
  let matchIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index;
    }
  }
  if (matchIndex < 0) {
    return null;
  }

  const start = Math.max(0, matchIndex - 80);
  const excerpt = text.slice(start, start + MAX_FINDING_LENGTH).trim();
  if (excerpt.length < MIN_FINDING_LENGTH) {
    return null;
  }

  return truncateFinding(excerpt);
}

// Anchor an excerpt on a strong investigation term first, so menus and boilerplate are not selected.
function excerptAroundBestTerm(text: string, extraTerms: string[]): string | null {
  const strongTerms = [...STRONG_RELEVANCE_TERMS, ...extraTerms];
  return excerptAroundTerm(text, strongTerms) ?? excerptAroundTerm(text, findingTerms(extraTerms));
}

// Prefer sentences that mention investigation terms; otherwise keep a short excerpt around a match.
function selectFinding(text: string, title: string, extraTerms: string[]): string | null {
  if (isUnusableTitle(title)) {
    return null;
  }

  const cleaned = normalizeText(text);
  if (isUnusable(cleaned)) {
    return null;
  }

  if (!isRelevantToInvestigation(cleaned, extraTerms)) {
    return null;
  }

  const terms = findingTerms(extraTerms);
  const sentences = splitSentences(cleaned);
  const matching = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    return terms.some((term) => containsTerm(lower, term));
  });

  if (matching.length > 0) {
    const combined = matching.slice(0, 2).join(" ");
    if (combined.length <= MAX_FINDING_LENGTH) {
      return combined;
    }
    // Pages with little punctuation split into one long block whose head is navigation chrome,
    // so anchor on the matched term rather than truncating from the start of the block.
    return excerptAroundBestTerm(combined, extraTerms) ?? truncateFinding(combined);
  }

  return excerptAroundBestTerm(cleaned, extraTerms);
}

// Without hypotheses, extracted page content is contextual rather than a diagnosis.
function classifyRelevance(): EvidenceRelevance {
  return "context";
}

// Convert visited page text into typed evidence. Unusable or irrelevant pages are skipped.
export function extractEvidence(pages: PageContent[], extraTerms: string[] = []): ExtractResult {
  const evidence: Evidence[] = [];
  const rejections: CandidateRejection[] = [];

  for (const page of pages) {
    const cleaned = normalizeText(page.text);
    if (isUnusableTitle(page.title) || isUnusable(cleaned)) {
      console.log(`Skipping unusable source content:\nURL: ${page.url}\n`);
      rejections.push({
        title: page.title,
        url: page.url,
        reason: "page content was unusable (blocked, too short, or challenge page)",
      });
      continue;
    }

    if (!isRelevantToInvestigation(cleaned, extraTerms)) {
      console.log(`Skipping irrelevant source content:\nURL: ${page.url}\n`);
      rejections.push({
        title: page.title,
        url: page.url,
        reason: "page text did not contain investigation terms such as P0305, misfire, or cylinder 5",
      });
      continue;
    }

    const finding = selectFinding(page.text, page.title, extraTerms);
    if (!finding) {
      console.log(`Skipping source with no usable finding:\nURL: ${page.url}\n`);
      rejections.push({
        title: page.title,
        url: page.url,
        reason: "no meaningful relevant excerpt could be taken from the page text",
      });
      continue;
    }

    evidence.push({
      title: page.title,
      url: page.url,
      finding,
      relevance: classifyRelevance(),
    });
  }

  return { evidence, rejections };
}
