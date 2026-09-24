import type { DiagnosticCase, DiagnosticCode } from "../types/diagnosticCase.js";
import type { InvestigationFormInput } from "../types/ui.js";

// Makes that are commonly typed as two words in free-form vehicle strings.
const TWO_WORD_MAKES = new Set([
  "land rover",
  "alfa romeo",
  "aston martin",
  "rolls royce",
]);

/**
 * Thrown when the tester form is missing required fields.
 * The UI surfaces message; the server logs the same text for development.
 */
export class InvestigationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationInputError";
  }
}

// True when a token looks like a four-digit model year.
function looksLikeYear(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token);
}

// True when a token looks like a chassis/platform code (W203, E46, F30, etc.).
function looksLikePlatform(token: string): boolean {
  return /^[A-Za-z]\d{2,3}[A-Za-z]?$/.test(token);
}

/**
 * Split a free-form vehicle string into the DiagnosticCase vehicle fields.
 * Handles common patterns such as "Mercedes-Benz C240 W203" and "Toyota Sienna 2008".
 */
export function parseVehicleString(vehicleText: string): DiagnosticCase["vehicle"] {
  const tokens = vehicleText.replace(/\s+/g, " ").trim().split(" ").filter((part) => part.length > 0);
  if (tokens.length === 0) {
    throw new InvestigationInputError("Vehicle is required.");
  }

  let make = tokens[0]!;
  let rest = tokens.slice(1);

  if (tokens.length >= 2) {
    const twoWord = `${tokens[0]} ${tokens[1]}`.toLowerCase();
    if (TWO_WORD_MAKES.has(twoWord)) {
      make = `${tokens[0]} ${tokens[1]}`;
      rest = tokens.slice(2);
    }
  }

  let year: number | undefined;
  let platform: string | undefined;
  const modelTokens = [...rest];

  if (modelTokens.length > 0 && looksLikeYear(modelTokens[modelTokens.length - 1]!)) {
    year = Number(modelTokens.pop());
  }

  if (modelTokens.length > 0 && looksLikePlatform(modelTokens[modelTokens.length - 1]!)) {
    platform = modelTokens.pop()!.toUpperCase();
  }

  const model = modelTokens.join(" ").trim();
  if (model.length === 0) {
    throw new InvestigationInputError(
      "Vehicle must include a model (for example: Mercedes-Benz C240 W203)."
    );
  }

  return {
    make,
    model,
    ...(platform ? { platform } : {}),
    ...(year !== undefined ? { year } : {}),
  };
}

// Parse a comma/whitespace separated diagnostic-code string into DiagnosticCode entries.
export function parseDiagnosticCodes(codesText: string): DiagnosticCode[] {
  const raw = codesText
    .split(/[,;\s]+/)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);

  const seen = new Set<string>();
  const codes: DiagnosticCode[] = [];
  for (const code of raw) {
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    codes.push({ code });
  }

  if (codes.length === 0) {
    throw new InvestigationInputError("At least one diagnostic code is required.");
  }

  return codes;
}

// Split multiline symptom/context text into non-empty symptom lines.
export function parseSymptoms(symptomsText: string): string[] | undefined {
  const lines = symptomsText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return undefined;
  }

  return lines;
}

/**
 * Convert tester UI form fields into the DiagnosticCase expected by runInvestigation.
 * Rejects empty vehicle and empty codes; symptoms are optional.
 */
export function parseInvestigationInput(input: InvestigationFormInput): DiagnosticCase {
  const vehicleText = typeof input.vehicle === "string" ? input.vehicle.trim() : "";
  const codesText = typeof input.codes === "string" ? input.codes.trim() : "";
  const symptomsText = typeof input.symptoms === "string" ? input.symptoms : "";

  if (vehicleText.length === 0) {
    throw new InvestigationInputError("Vehicle is required.");
  }

  if (codesText.length === 0) {
    throw new InvestigationInputError("At least one diagnostic code is required.");
  }

  const vehicle = parseVehicleString(vehicleText);
  const codes = parseDiagnosticCodes(codesText);
  const symptoms = parseSymptoms(symptomsText);

  return {
    vehicle,
    codes,
    ...(symptoms ? { symptoms } : {}),
  };
}
