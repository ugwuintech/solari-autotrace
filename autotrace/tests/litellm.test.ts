import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiteLlmProvider, readCompletion } from "../src/llm/litellm.js";
import { createProviderFromEnv } from "../src/llm/selectProvider.js";
import type { DiagnosticCase } from "../src/types/diagnosticCase.js";
import type { Evidence } from "../src/types/evidence.js";
import type { HypothesisBoard } from "../src/types/hypothesis.js";
import type { ReasoningRequest } from "../src/types/reasoning.js";

const coilEvidence: Evidence = {
  title: "Cylinder 5 coil swap",
  url: "https://example.test/coil",
  finding: "A coil swap moved the misfire with the coil.",
  relevance: "supports",
};

// A one-hypothesis request so the fixture assessment stays small.
function sampleRequest(): ReasoningRequest {
  const diagnosticCase: DiagnosticCase = {
    vehicle: { make: "Mercedes-Benz", model: "C240", platform: "W203" },
    codes: [{ code: "P0305", description: "Cylinder 5 misfire" }],
  };

  const board: HypothesisBoard = {
    hypotheses: [
      {
        hypothesis: {
          id: "H1",
          label: "Ignition-related misfire",
          claim: "A fault in the ignition path could produce the misfire.",
          possibleCauses: ["failed ignition coil"],
        },
        mentions: [],
      },
    ],
    unmentionedEvidence: [],
  };

  return { diagnosticCase, board, evidence: [coilEvidence] };
}

const validContent = JSON.stringify({
  hypothesisAssessments: [
    {
      hypothesisId: "H1",
      support: "moderately-supported",
      explanation: "A coil swap moved the misfire.",
      supportingEvidence: [{ title: coilEvidence.title, url: coilEvidence.url }],
      contradictingEvidence: [],
    },
  ],
  conflicts: [],
  unknowns: [],
  recommendedNextTest: {
    name: "Swap the cylinder 5 coil",
    purpose: "See whether the misfire follows the coil.",
    procedure: ["Swap the cylinder 5 coil with another cylinder and clear the codes."],
    distinguishes: ["H1"],
  },
  reasoning: "Ignition remains plausible.",
});

type RecordedCall = { url: string; init: RequestInit | undefined };

// A fetch stand-in that records the request and answers with a fixed response.
function fakeFetch(status: number, body: unknown, calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

function completion(content: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

describe("readCompletion", () => {
  it("reads content and token usage from an OpenAI-style response", () => {
    const result = readCompletion(completion("{}"));
    assert.equal(result.content, "{}");
    assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  });

  it("rejects a response without message content", () => {
    assert.throws(() => readCompletion({ choices: [] }), /no message content/);
  });
});

describe("createLiteLlmProvider", () => {
  it("requires an API key", () => {
    assert.throws(() => createLiteLlmProvider({ apiKey: "" }), /LITELLM_API_KEY is not set/);
  });

  it("sends the schema-constrained prompt and returns a validated assessment", async () => {
    const calls: RecordedCall[] = [];
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://gateway.test/v1/",
      model: "claude-haiku",
      fetch: fakeFetch(200, completion(validContent), calls),
    });

    const assessment = await provider.reason(sampleRequest());

    assert.equal(provider.name, "litellm-claude-haiku");
    assert.equal(assessment.hypothesisAssessments[0]?.support, "moderately-supported");
    assert.equal(calls[0]?.url, "https://gateway.test/v1/chat/completions");

    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key");

    const sent: unknown = JSON.parse(String(calls[0]?.init?.body));
    assert.ok(typeof sent === "object" && sent !== null && "response_format" in sent);
  });

  it("reports gateway errors with provider context", async () => {
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      fetch: fakeFetch(429, "budget exceeded", []),
    });

    await assert.rejects(provider.reason(sampleRequest()), /Provider: litellm-.*[\s\S]*429[\s\S]*budget exceeded/);
  });

  it("rejects output that cites evidence that was never collected", async () => {
    const fabricated = validContent.replace(coilEvidence.url, "https://example.test/invented");
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      fetch: fakeFetch(200, completion(fabricated), []),
    });

    await assert.rejects(provider.reason(sampleRequest()), /AutoTrace reasoning failed/);
  });
});

describe("createProviderFromEnv", () => {
  it("defaults to the local Ollama provider", () => {
    assert.match(createProviderFromEnv({}).name, /^ollama-/);
  });

  it("selects LiteLLM when asked", () => {
    const provider = createProviderFromEnv({ AUTOTRACE_LLM: "litellm", LITELLM_API_KEY: "k" });
    assert.match(provider.name, /^litellm-/);
  });

  it("rejects an unknown provider", () => {
    assert.throws(() => createProviderFromEnv({ AUTOTRACE_LLM: "gpt" }), /Unknown AUTOTRACE_LLM/);
  });
});
