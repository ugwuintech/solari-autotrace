import type { DiagnosticCase } from "../types/diagnosticCase.js";

const MAX_QUERIES = 4;

// Prefer the chassis/platform token when present so queries stay vehicle-specific.
function platformOrModel(diagnosticCase: DiagnosticCase): string {
  return diagnosticCase.vehicle.platform ?? diagnosticCase.vehicle.model;
}

// Drop empty strings and keep first-seen order so the query set stays small.
function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const query of queries) {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    unique.push(normalized);
  }
  return unique;
}

// Build a small set of deterministic search queries from the case. Does not encode a diagnosis.
export function buildResearchQueries(diagnosticCase: DiagnosticCase): string[] {
  const make = diagnosticCase.vehicle.make;
  const model = diagnosticCase.vehicle.model;
  const chassis = platformOrModel(diagnosticCase);
  const codes = diagnosticCase.codes.map((item) => item.code).filter((code) => code.length > 0);
  const primaryCode = codes[0];
  const symptoms = (diagnosticCase.symptoms ?? []).join(" ").trim();

  const queries: string[] = [];

  if (primaryCode) {
    const symptomPart = symptoms ? ` ${symptoms}` : "";
    queries.push(`${make} ${model} ${chassis} ${primaryCode}${symptomPart}`);
    queries.push(`${make} ${chassis} ${primaryCode} diagnostic forum`);
    queries.push(`${primaryCode} ${chassis} misfire site:mbworld.org`);
  }

  if (codes.length > 1) {
    queries.push(`${make} ${chassis} ${codes.join(" ")} diagnostic`);
  }

  return uniqueQueries(queries).slice(0, MAX_QUERIES);
}
