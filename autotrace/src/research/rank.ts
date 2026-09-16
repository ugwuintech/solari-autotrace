import type { DiagnosticCase } from "../types/diagnosticCase.js";
import type { SearchResult } from "../types/search.js";

const TRACKING_PARAM_NAMES = new Set([
  "msclkid",
  "fbclid",
  "gclid",
  "yclid",
  "mc_cid",
  "mc_eid",
]);

const GENERIC_BRAND_HOST_SUFFIXES = ["mbusa.com", "mercedes-benz.com"];

const INVENTORY_HOST_SUFFIXES = [
  "cars.com",
  "autotrader.com",
  "cargurus.com",
  "carsforsale.com",
  "truecar.com",
  "carvana.com",
];

const LOW_VALUE_PATH_PATTERNS = [
  "/inventory",
  "/new-inventory",
  "/used-inventory",
  "/certified-inventory",
  "/vehicles-for-sale",
  "/vehicle-details",
  "/vehicledetails",
  "/cars-for-sale",
  "/pre-owned",
  "/new-vehicles",
  "/used-vehicles",
  "/all-vehicles",
  "/vdp/",
  "/specials",
  "/lease",
  "/finance",
  "/financing",
  "/new-mercedes",
  "/used-mercedes",
];

const LOW_VALUE_TITLE_PATTERNS = [
  "for sale",
  "inventory",
  "in stock",
  "near me",
  "dealership",
  "new & used",
  "new and used",
  "lease deals",
  "apr financing",
  "special offers",
];

/**
 * Scoring weights. Vehicle/platform specificity outweighs any single diagnostic keyword so a
 * W203 discussion outranks a keyword-dense page that never mentions the vehicle. Weights are
 * fixed constants: a score can always be explained by the signals recorded alongside it.
 */
const VEHICLE_SPECIFIC_WEIGHT = 6;
const VEHICLE_FAMILY_WEIGHT = 3;
const VEHICLE_MAKE_WEIGHT = 2;
const VEHICLE_SPECIFIC_BONUS = 3;
const CODE_WEIGHT = 4;
const SYMPTOM_WEIGHT = 3;
const TECHNICAL_WEIGHT = 2;
const SYSTEM_WEIGHT = 1;
const FORUM_SOURCE_WEIGHT = 5;
const TECHNICAL_SOURCE_WEIGHT = 4;
const GENERIC_CODE_REFERENCE_PENALTY = 5;
const NO_VEHICLE_CONTEXT_PENALTY = 3;

/**
 * Caps on how many groups of each kind can score. Titles and URLs that repeat near-synonyms
 * ("diagnostic dtc troubleshooting repair") must not outscore vehicle-specific material through
 * term density alone.
 */
const MAX_VEHICLE_GROUPS = 3;
const MAX_TECHNICAL_GROUPS = 2;
const MAX_SYSTEM_GROUPS = 3;

// Penalised pages stay selectable at low priority; the evidence gate decides if their text qualifies.
const MIN_KEPT_SCORE = 1;

// Leave at least one visit for a second host, so evidence never comes from a single site.
const MAX_PAGES_PER_HOST = 3;

// A set of interchangeable terms that should score once, regardless of how many of them appear.
export type TermGroup = {
  label: string;
  terms: string[];
};

/**
 * A vehicle term group carries its own weight: naming the model or platform ("C240", "W203") is
 * much stronger evidence of a vehicle-specific source than naming the marque or model family.
 */
export type VehicleTermGroup = TermGroup & {
  weight: number;
  specific: boolean;
};

const SYMPTOM_GROUPS: TermGroup[] = [
  { label: "misfire", terms: ["misfire", "misfires", "misfiring"] },
  { label: "cylinder 5", terms: ["cylinder 5", "cylinder5", "cyl 5", "cylinder no 5"] },
];

const TECHNICAL_GROUPS: TermGroup[] = [
  { label: "diagnosis", terms: ["diagnostic", "diagnostics", "diagnosis", "diagnose", "dtc"] },
  { label: "testing", terms: ["troubleshoot", "troubleshooting", "test", "testing", "measure"] },
  { label: "repair", terms: ["repair", "repaired", "fixed", "replaced"] },
];

const SYSTEM_GROUPS: TermGroup[] = [
  { label: "ignition", terms: ["ignition", "coil", "coils", "spark plug", "spark plugs"] },
  { label: "fuel", terms: ["fuel", "injector", "injectors"] },
  { label: "mechanical", terms: ["compression", "valve", "valves", "camshaft"] },
  { label: "air/egr", terms: ["egr", "intake", "vacuum leak", "air management"] },
];

// Marque forums and technician communities that discuss specific vehicles and repairs.
const FORUM_HOST_SUFFIXES = [
  "mbworld.org",
  "benzworld.org",
  "peachparts.com",
  "mbclub.co.uk",
  "2carpros.com",
  "mechanics.stackexchange.com",
];

// Structural signs of a discussion thread rather than a static article.
const FORUM_URL_PATTERNS = ["/forum", "/forums", "/threads", "/showthread", "/topic", "/viewtopic", "community."];

const FORUM_TITLE_PATTERNS = ["forum", "forums", "thread"];

// Professional/technical service information sources.
const TECHNICAL_SOURCE_HOST_SUFFIXES = [
  "alldata.com",
  "alldatadiy.com",
  "mitchell1.com",
  "identifix.com",
  "motor.com",
  "startekinfo.com",
  "mercedesmedic.com",
  "nhtsa.gov",
];

// Service documentation wording, wherever it is published.
const TECHNICAL_DOCUMENT_PATTERNS = [
  "tsb",
  "technical service bulletin",
  "service bulletin",
  "service manual",
  "repair manual",
  "workshop manual",
  "wiring diagram",
];

// Sites whose pages are code dictionaries: useful background, but rarely vehicle-specific.
const GENERIC_CODE_HOST_SUFFIXES = [
  "obd-codes.com",
  "engine-codes.com",
  "troublecodes.net",
  "autocodes.com",
  "obd2-code.com",
  "dtcdecode.com",
  "obdcodes.com",
];

export type RankTerms = {
  codes: string[];
  vehicleGroups: VehicleTermGroup[];
};

export type CandidateEvaluation = {
  result: SearchResult;
  score: number;
  signals: string[];
  exclusionReason: string | null;
};

// Normalize a URL for cross-query deduplication without changing the stored source URL.
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

// Keep the first occurrence of each destination URL across all queries.
export function deduplicateByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrl(result.url);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(result);
  }
  return unique;
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

// Spacing/hyphenation variants of a designation such as "C240" or "W203", as written in URLs and titles.
function designationVariants(designation: string): string[] {
  const value = designation.toLowerCase().trim();
  const parts = /^([a-z]+)[\s-]?(\d+)$/.exec(value);
  if (!parts) {
    return [value];
  }
  return [`${parts[1]}${parts[2]}`, `${parts[1]} ${parts[2]}`, `${parts[1]}-${parts[2]}`];
}

/**
 * Mercedes model names combine a class letter with a displacement number ("C240"), and sources
 * often name the class instead of the model. This is derived from the supplied model designation
 * only: no engine, platform, or model fact is assumed that the case did not provide.
 */
function modelClassVariants(model: string): string[] {
  const parts = /^([a-z]{1,3})[\s-]?\d{2,3}$/.exec(model.toLowerCase().trim());
  if (!parts) {
    return [];
  }
  return [`${parts[1]}-class`, `${parts[1]} class`, `${parts[1]}class`];
}

// "Mercedes-Benz" is also written as "Mercedes" or "Benz", so score the make on any of its words.
function makeVariants(make: string): string[] {
  const value = make.toLowerCase().trim();
  const words = value.split(/[\s-]+/).filter((word) => word.length > 2);
  return [value, ...words];
}

/**
 * Vehicle and platform terms to score, built from the case only.
 * `engine` contributes when the case supplies it (an engine designation such as M112 is a vehicle
 * fact and is never inferred here).
 */
export function vehicleRankGroups(vehicle: DiagnosticCase["vehicle"]): VehicleTermGroup[] {
  const groups: VehicleTermGroup[] = [
    {
      label: `model:${vehicle.model}`,
      terms: designationVariants(vehicle.model),
      weight: VEHICLE_SPECIFIC_WEIGHT,
      specific: true,
    },
  ];

  if (vehicle.platform) {
    groups.push({
      label: `platform:${vehicle.platform}`,
      terms: designationVariants(vehicle.platform),
      weight: VEHICLE_SPECIFIC_WEIGHT,
      specific: true,
    });
  }

  if (vehicle.engine) {
    groups.push({
      label: `engine:${vehicle.engine}`,
      terms: designationVariants(vehicle.engine),
      weight: VEHICLE_SPECIFIC_WEIGHT,
      specific: true,
    });
  }

  const classVariants = modelClassVariants(vehicle.model);
  if (classVariants.length > 0) {
    groups.push({
      label: `class:${classVariants[0]}`,
      terms: classVariants,
      weight: VEHICLE_FAMILY_WEIGHT,
      specific: false,
    });
  }

  groups.push({
    label: `make:${vehicle.make}`,
    terms: makeVariants(vehicle.make),
    weight: VEHICLE_MAKE_WEIGHT,
    specific: false,
  });

  return groups;
}

// Build the deterministic ranking terms for a case: its DTCs plus its vehicle/platform terms.
export function buildRankTerms(diagnosticCase: DiagnosticCase): RankTerms {
  return {
    codes: diagnosticCase.codes.map((item) => item.code).filter((code) => code.length > 0),
    vehicleGroups: vehicleRankGroups(diagnosticCase.vehicle),
  };
}

// Labels of the groups whose terms appear in the haystack, each group counted once.
function matchedGroups(haystack: string, groups: TermGroup[]): string[] {
  return groups
    .filter((group) => group.terms.some((term) => containsTerm(haystack, term)))
    .map((group) => group.label);
}

// Matched vehicle groups, strongest first, so the most specific matches are the ones that score.
function matchedVehicleGroups(haystack: string, groups: VehicleTermGroup[]): VehicleTermGroup[] {
  return groups
    .filter((group) => group.terms.some((term) => containsTerm(haystack, term)))
    .sort((left, right) => right.weight - left.weight);
}

// True when the title or URL already looks like diagnostic/technical material.
function hasTechnicalSignal(haystack: string, terms: RankTerms): boolean {
  for (const code of terms.codes) {
    if (containsTerm(haystack, code)) {
      return true;
    }
  }
  return matchedGroups(haystack, SYMPTOM_GROUPS).length > 0;
}

// True when the hostname is a dealer, inventory, or generic manufacturer marketing site.
function isLowValueHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (INVENTORY_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return true;
  }
  if (GENERIC_BRAND_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return true;
  }
  if (host.includes("mercedesbenzof") || host.includes("mbof")) {
    return true;
  }
  if (
    /mercedes-benz\.(com|net|ca)$/.test(host) &&
    host !== "www.mercedes-benz.com" &&
    host !== "mercedes-benz.com"
  ) {
    return true;
  }
  return false;
}

// True when the path is a locale homepage such as / or /en/home.
function isGenericHomepagePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") {
    return true;
  }
  return /^\/[a-z]{2}(-[a-z]{2})?(\/home)?$/i.test(path);
}

// True when the path is a sales/inventory/advertising page.
function hasLowValuePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return LOW_VALUE_PATH_PATTERNS.some((pattern) => path.includes(pattern));
}

// Generic dealer homepages and inventory/ad pages are excluded unless the hit already looks technical.
function isLowValueSource(result: SearchResult, terms: RankTerms): boolean {
  const haystack = `${result.title} ${result.url}`.toLowerCase();
  if (hasTechnicalSignal(haystack, terms)) {
    return false;
  }

  const title = result.title.toLowerCase();
  if (LOW_VALUE_TITLE_PATTERNS.some((pattern) => title.includes(pattern))) {
    return true;
  }

  try {
    const parsed = new URL(result.url);
    if (isLowValueHost(parsed.hostname) || hasLowValuePath(parsed.pathname)) {
      return true;
    }
    if (isGenericHomepagePath(parsed.pathname)) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

// Read the hostname, or an empty string when the URL cannot be parsed.
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Read the path, or an empty string when the URL cannot be parsed.
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

// True when the hostname ends with one of the listed registrable suffixes.
function hostMatches(hostname: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

// True when the result looks like an automotive forum or technician discussion.
function isForumSource(result: SearchResult): boolean {
  const hostname = hostnameOf(result.url);
  if (hostMatches(hostname, FORUM_HOST_SUFFIXES)) {
    return true;
  }
  const location = `${hostname}${pathnameOf(result.url)}`;
  if (FORUM_URL_PATTERNS.some((pattern) => location.includes(pattern))) {
    return true;
  }
  const title = result.title.toLowerCase();
  return FORUM_TITLE_PATTERNS.some((pattern) => containsTerm(title, pattern));
}

// True when the result looks like professional technical or service documentation.
function isTechnicalSource(result: SearchResult): boolean {
  if (hostMatches(hostnameOf(result.url), TECHNICAL_SOURCE_HOST_SUFFIXES)) {
    return true;
  }
  const haystack = `${result.title} ${pathnameOf(result.url)}`.toLowerCase();
  return TECHNICAL_DOCUMENT_PATTERNS.some((pattern) => containsTerm(haystack, pattern));
}

// True when the URL path is a bare code lookup slug such as /p0305 or /dtc/p0305-code.html.
function isCodeLookupPath(pathname: string, codes: string[]): boolean {
  return codes.some((code) => {
    const escaped = code.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|/)((dtc|obd2?|code|p)-)?${escaped}(-(code|dtc|obd2?))?(\\.html?)?/?$`).test(pathname);
  });
}

// True when the result is a code dictionary entry rather than vehicle-specific material.
function isGenericCodeReference(result: SearchResult, terms: RankTerms): boolean {
  if (hostMatches(hostnameOf(result.url), GENERIC_CODE_HOST_SUFFIXES)) {
    return true;
  }
  return isCodeLookupPath(pathnameOf(result.url), terms.codes);
}

type CandidateScore = {
  score: number;
  signals: string[];
};

/**
 * Score a search hit from its title and URL.
 * Vehicle/platform specificity and source type drive the score; keyword density is capped.
 * Generic code references are demoted rather than excluded, because their page text may still
 * qualify as evidence once the relevance gate reads it.
 */
function scoreCandidate(result: SearchResult, terms: RankTerms): CandidateScore {
  if (isLowValueSource(result, terms)) {
    return { score: 0, signals: [] };
  }

  const haystack = `${result.title} ${result.url}`.toLowerCase();
  const matchedCodes = terms.codes.filter((code) => containsTerm(haystack, code));
  const vehicleMatches = matchedVehicleGroups(haystack, terms.vehicleGroups).slice(0, MAX_VEHICLE_GROUPS);
  const symptomMatches = matchedGroups(haystack, SYMPTOM_GROUPS);
  if (matchedCodes.length === 0 && vehicleMatches.length === 0 && symptomMatches.length === 0) {
    return { score: 0, signals: [] };
  }

  const technicalMatches = matchedGroups(haystack, TECHNICAL_GROUPS).slice(0, MAX_TECHNICAL_GROUPS);
  const systemMatches = matchedGroups(haystack, SYSTEM_GROUPS).slice(0, MAX_SYSTEM_GROUPS);
  const signals: string[] = [];
  let score = 0;

  for (const group of vehicleMatches) {
    score += group.weight;
    signals.push(`${group.label} (+${group.weight})`);
  }
  if (vehicleMatches.some((group) => group.specific)) {
    score += VEHICLE_SPECIFIC_BONUS;
    signals.push(`vehicle-specific match (+${VEHICLE_SPECIFIC_BONUS})`);
  }
  for (const code of matchedCodes) {
    score += CODE_WEIGHT;
    signals.push(`code:${code} (+${CODE_WEIGHT})`);
  }
  for (const label of symptomMatches) {
    score += SYMPTOM_WEIGHT;
    signals.push(`symptom:${label} (+${SYMPTOM_WEIGHT})`);
  }
  for (const label of technicalMatches) {
    score += TECHNICAL_WEIGHT;
    signals.push(`technical:${label} (+${TECHNICAL_WEIGHT})`);
  }
  for (const label of systemMatches) {
    score += SYSTEM_WEIGHT;
    signals.push(`system:${label} (+${SYSTEM_WEIGHT})`);
  }

  // A source counts once as either a discussion or documentation, never as both.
  if (isForumSource(result)) {
    score += FORUM_SOURCE_WEIGHT;
    signals.push(`source:forum (+${FORUM_SOURCE_WEIGHT})`);
  } else if (isTechnicalSource(result)) {
    score += TECHNICAL_SOURCE_WEIGHT;
    signals.push(`source:technical documentation (+${TECHNICAL_SOURCE_WEIGHT})`);
  }

  if (isGenericCodeReference(result, terms)) {
    score -= GENERIC_CODE_REFERENCE_PENALTY;
    signals.push(`generic code reference (-${GENERIC_CODE_REFERENCE_PENALTY})`);
  }
  if (vehicleMatches.length === 0) {
    score -= NO_VEHICLE_CONTEXT_PENALTY;
    signals.push(`no vehicle context (-${NO_VEHICLE_CONTEXT_PENALTY})`);
  }

  return { score: Math.max(MIN_KEPT_SCORE, score), signals };
}

// Explain why a candidate will not be visited.
function exclusionReason(result: SearchResult, score: number, terms: RankTerms): string | null {
  if (score > 0) {
    return null;
  }
  if (isLowValueSource(result, terms)) {
    return "generic dealer, inventory, advertisement, or homepage";
  }
  return "title and URL lacked vehicle, code, or symptom terms";
}

// Score unique candidates and record the signals behind each score.
export function evaluateCandidates(results: SearchResult[], terms: RankTerms): CandidateEvaluation[] {
  return deduplicateByUrl(results).map((result) => {
    const scored = scoreCandidate(result, terms);
    return {
      result,
      score: scored.score,
      signals: scored.signals,
      exclusionReason: exclusionReason(result, scored.score, terms),
    };
  });
}

// Order the scoring candidates by score, keeping search order as a stable tiebreak.
export function rankCandidates(evaluations: CandidateEvaluation[]): CandidateEvaluation[] {
  return evaluations
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.score > 0)
    .sort((left, right) => right.item.score - left.item.score || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * Keep a small visit set: highest-scoring candidates first, capped per host.
 * Remaining slots are filled from the same ranked order if the host cap left the set short,
 * so the number of visited pages stays predictable.
 */
export function selectCandidates(ranked: CandidateEvaluation[], limit: number): SearchResult[] {
  const perHost = new Map<string, number>();
  const selected: SearchResult[] = [];
  const deferred: SearchResult[] = [];

  for (const candidate of ranked) {
    if (selected.length >= limit) {
      break;
    }
    const host = hostnameOf(candidate.result.url);
    const visits = perHost.get(host) ?? 0;
    if (visits >= MAX_PAGES_PER_HOST) {
      deferred.push(candidate.result);
      continue;
    }
    perHost.set(host, visits + 1);
    selected.push(candidate.result);
  }

  for (const result of deferred) {
    if (selected.length >= limit) {
      break;
    }
    selected.push(result);
  }

  return selected;
}
