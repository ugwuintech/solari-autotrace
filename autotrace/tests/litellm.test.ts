import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiteLlmProvider, readCompletion, relaxSchema } from "../src/llm/litellm.js";
import type { RecoveryEvent } from "../src/types/recovery.js";
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

// A fetch stand-in that answers each call with the next queued response.
function queuedFetch(responses: Array<{ status: number; body: unknown }>, calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses[calls.length - 1] ?? responses[responses.length - 1];
    if (!next) {
      throw new Error("no queued response");
    }
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status });
  };
}

// The response_format type sent on one recorded call.
function sentFormat(call: RecordedCall | undefined): unknown {
  const sent: unknown = JSON.parse(String(call?.init?.body));
  return typeof sent === "object" && sent !== null && "response_format" in sent ? sent.response_format : undefined;
}

// The real Bedrock refusal observed in the baseline run, trimmed.
const bedrockSchemaRefusal =
  "litellm.BadRequestError: BedrockException - output_config.format.schema: For 'array' type, 'minItems' values other than 0 or 1 are not supported (got: [2, 5])";

describe("relaxSchema", () => {
  it("removes array-length bounds at every depth and keeps everything else", () => {
    const relaxed = relaxSchema({
      type: "object",
      required: ["list"],
      properties: {
        list: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", enum: ["H1"] } },
      },
    });

    assert.deepEqual(relaxed, {
      type: "object",
      required: ["list"],
      properties: { list: { type: "array", items: { type: "string", enum: ["H1"] } } },
    });
  });
});

describe("response format recovery", () => {
  it("retries without array bounds when the backend refuses the schema, and records the recovery", async () => {
    const calls: RecordedCall[] = [];
    const recoveries: RecoveryEvent[] = [];
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      fetch: queuedFetch(
        [
          { status: 400, body: bedrockSchemaRefusal },
          { status: 200, body: completion(validContent) },
        ],
        calls
      ),
      onRecovery: (event) => recoveries.push(event),
    });

    const assessment = await provider.reason(sampleRequest());

    assert.equal(assessment.hypothesisAssessments.length, 1);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(sentFormat(calls[1])), /minItems|maxItems/);
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0]?.step, "reasoning");
    assert.match(recoveries[0]?.failure ?? "", /minItems/);
  });

  it("falls back to plain JSON mode when the relaxed schema is refused too", async () => {
    const calls: RecordedCall[] = [];
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      fetch: queuedFetch(
        [
          { status: 400, body: bedrockSchemaRefusal },
          { status: 400, body: "response_format json_schema is not supported" },
          { status: 200, body: completion(validContent) },
        ],
        calls
      ),
    });

    await provider.reason(sampleRequest());

    assert.deepEqual(sentFormat(calls[2]), { type: "json_object" });
  });

  it("does not retry a failure that is not about the response format", async () => {
    const calls: RecordedCall[] = [];
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      fetch: queuedFetch([{ status: 401, body: "invalid api key" }], calls),
    });

    await assert.rejects(provider.reason(sampleRequest()), /401/);
    assert.equal(calls.length, 1);
  });

  it("still rejects an invalid reply produced under a relaxed format", async () => {
    const incomplete = JSON.stringify({ ...JSON.parse(validContent), hypothesisAssessments: [] });
    const provider = createLiteLlmProvider({
      apiKey: "test-key",
      fetch: queuedFetch(
        [
          { status: 400, body: bedrockSchemaRefusal },
          { status: 200, body: completion(incomplete) },
        ],
        []
      ),
    });

    await assert.rejects(provider.reason(sampleRequest()), /AutoTrace reasoning failed/);
  });
});
