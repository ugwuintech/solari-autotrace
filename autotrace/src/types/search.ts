export type SearchResult = {
  title: string;
  url: string;
};

// Organic search results collected for a single research query.
export type SearchQueryResults = {
  query: string;
  results: SearchResult[];
};

// A search engine block, consent wall, or CAPTCHA challenge, recorded instead of being worked around.
export type SearchBlock = {
  query: string;
  reason: string;
  pageTitle: string;
  pageUrl: string;
};

// Everything one search engine run produced, including any block that stopped it.
export type SearchOutcome = {
  engine: string;
  batches: SearchQueryResults[];
  blocks: SearchBlock[];
};
