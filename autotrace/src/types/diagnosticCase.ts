// A diagnostic trouble code supplied with the case.
export type DiagnosticCode = {
  code: string;
  description?: string;
  status?: string;
};

// The vehicle and diagnostic information for one investigation.
export type DiagnosticCase = {
  vehicle: {
    make: string;
    model: string;
    platform?: string;
    year?: number;
    engine?: string;
  };
  codes: DiagnosticCode[];
  symptoms?: string[];
  additionalInformation?: string[];
};
