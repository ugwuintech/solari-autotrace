import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvestigationInputError,
  parseDiagnosticCodes,
  parseInvestigationInput,
  parseVehicleString,
} from "../src/ui/parseInvestigationInput.js";

describe("parseInvestigationInput", () => {
  it("converts valid form fields into a DiagnosticCase", () => {
    const diagnosticCase = parseInvestigationInput({
      vehicle: "Mercedes-Benz C240 W203",
      codes: "P0305, P2001, P0400",
      symptoms:
        "Cylinder 5 misfire.\nPrevious ignition and injector swaps did not move the misfire.",
    });

    assert.deepEqual(diagnosticCase.vehicle, {
      make: "Mercedes-Benz",
      model: "C240",
      platform: "W203",
    });
    assert.deepEqual(
      diagnosticCase.codes.map((item) => item.code),
      ["P0305", "P2001", "P0400"]
    );
    assert.deepEqual(diagnosticCase.symptoms, [
      "Cylinder 5 misfire.",
      "Previous ignition and injector swaps did not move the misfire.",
    ]);
  });

  it("rejects an empty vehicle", () => {
    assert.throws(
      () =>
        parseInvestigationInput({
          vehicle: "   ",
          codes: "P0305",
          symptoms: "",
        }),
      (error: unknown) =>
        error instanceof InvestigationInputError && error.message === "Vehicle is required."
    );
  });

  it("rejects empty diagnostic codes", () => {
    assert.throws(
      () =>
        parseInvestigationInput({
          vehicle: "Toyota Sienna 2008",
          codes: " , ; ",
          symptoms: "Rough idle",
        }),
      (error: unknown) =>
        error instanceof InvestigationInputError &&
        error.message === "At least one diagnostic code is required."
    );
  });

  it("parses a year-bearing vehicle string", () => {
    assert.deepEqual(parseVehicleString("Toyota Sienna 2008"), {
      make: "Toyota",
      model: "Sienna",
      year: 2008,
    });
  });

  it("strips a leading model year before assigning make", () => {
    assert.deepEqual(parseVehicleString("2014 Mercedes-Benz C240 W203"), {
      make: "Mercedes-Benz",
      model: "C240",
      platform: "W203",
      year: 2014,
    });
  });

  it("recognizes a year immediately before a platform code", () => {
    assert.deepEqual(parseVehicleString("Mercedes-Benz 2014 W212"), {
      make: "Mercedes-Benz",
      model: "W212",
      platform: "W212",
      year: 2014,
    });
  });

  it("parses diagnostic codes from mixed separators", () => {
    assert.deepEqual(
      parseDiagnosticCodes("p0305; P0400  p2001, P0305").map((item) => item.code),
      ["P0305", "P0400", "P2001"]
    );
  });
});
