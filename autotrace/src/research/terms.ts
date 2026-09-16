import type { TermGroup } from "../types/terms.js";

// True when haystack contains a whole term, so short tokens do not match unrelated words.
export function containsTerm(haystack: string, term: string): boolean {
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

// True when any term of the group appears in the haystack.
export function groupMatches(haystack: string, group: TermGroup): boolean {
  return group.terms.some((term) => containsTerm(haystack, term));
}

// Labels of the groups whose terms appear in the haystack, each group counted once.
export function matchedGroupLabels(haystack: string, groups: TermGroup[]): string[] {
  return groups.filter((group) => groupMatches(haystack, group)).map((group) => group.label);
}

// The individual terms that matched, first-seen order and deduplicated, so a match stays traceable.
export function matchedTerms(haystack: string, groups: TermGroup[]): string[] {
  const matched: string[] = [];
  for (const group of groups) {
    for (const term of group.terms) {
      if (containsTerm(haystack, term) && !matched.includes(term)) {
        matched.push(term);
      }
    }
  }
  return matched;
}
