# AutoTrace Research Agent

AutoTrace is an automotive diagnostic research agent. Given a vehicle, diagnostic trouble codes (DTCs), and optional symptoms, it researches technical web sources via Solari cloud browsers, collects structured evidence, evaluates competing diagnostic hypotheses, runs a bounded follow-up research round when needed, and produces a validated structured diagnostic assessment through a local Ollama/Qwen model.

It is a research assistant for diagnostic reasoning, not a parts-replacement chatbot and not a confirmed vehicle diagnosis.

## Built during neatHack (Oct 10–12, 2026)

AutoTrace existed before the hackathon (commits up to `feeac7e`, Sept 24, plus the UI redesign in `08ffd9d`). Everything from `1eda599` onwards on the `neathack` branch was built during the event:

| Commit | What |
| --- | --- |
| `1eda599` | Entire checkpoint capture, with every commit linked to the Claude Code session that produced it |
| `343f381` | LiteLLM provider (hosted Claude/Nova) selectable with `AUTOTRACE_LLM`, same evidence validation as Ollama |
| `7123d0b`, `e23af18` | Neatlogs tracing of the whole investigation: search, page extraction, evidence, follow-up planning, each LLM call with token usage, and assessment validation as a guardrail |
| `4cd77db` | Recovery when the model backend refuses the response schema |
| `22a493b` | Deduplicate forum threads listed under several URLs |
| `3d28d15` | Retry a timed-out search once instead of ending research |
| `866c7c0` | Retry Solari session creation once after a transient failure |
| `1c318f0` | Mark a stopped search as a failed span; remember the accepted response format across rounds |
| `422dd1e` | Stream real investigation progress to the web UI (NDJSON) |
| `78fb0a7` | Live activity feed in the UI, plus light and dark themes |
| `5354e0c` | Skip unreadable sources, backfill once when no page yields evidence, explain stopped searches |

### How Neatlogs drove the changes

Each fix came from a failure seen in a traced run, not from a guess:

1. **Baseline run, failed.** Research succeeded, then Bedrock (behind the LiteLLM gateway) rejected the assessment schema: `minItems values other than 0 or 1 are not supported`. The trace also showed two of the four source visits spent on the same mbworld.org thread under two URLs.
2. **Second run, 0 evidence.** The first DuckDuckGo query hit a 25s navigation timeout, which the code treated as a block, so every remaining query was skipped.
3. **Third run, failed before research.** Solari returned `POST /sessions: exhausted 2 attempts`; a probe minutes later launched fine.
4. **Neatlogs dashboard review.** The zero-evidence run showed no detection at all, because the stopped search was only recorded in output. The successful trace also showed the refused schema being retried again in round 2. Both fixed in `1c318f0`.
5. **Live UI runs.** One run spent all four page visits on paywalled answers and a video playlist and ended with zero evidence despite 50 search results. Another hit DuckDuckGo rate limiting: the homepage loaded but every search request timed out. Fixed or explained in `5354e0c`.

### Before and after (same case, same model: C240 W203, `claude-sonnet-4.6`)

| | Baseline | After |
| --- | --- | --- |
| Outcome | Failed, no assessment | Complete, validated assessment |
| Research rounds | 1, then failed at reasoning | 2 (targeted follow-up) |
| Distinct sources from 4 round-1 visits | 3 | 4 |
| Evidence items | not reached | 5 |
| Failures recovered | 0 | 4 (2 search timeouts, 2 schema refusals) |

This is one run on each side: it shows the observed failures are now handled, not a statistical improvement.

### Failure recovery rules

Every recovery is recorded as a `RecoveryEvent` (step, failure, action), carried on the investigation result, printed by the CLI and shown in the web UI under "Recovered failures". Recovery never weakens the evidence rules:

- **Schema refused by the backend:** step down `json_schema` → schema without array bounds → `json_object`. Every reply is still validated by `parseAssessment` (full hypothesis coverage, citations only to collected evidence).
- **Search navigation error (timeout):** retry the query once in a fresh tab. A detected challenge or block page is never retried.
- **Solari session creation exhausted:** wait 10s and launch once more. Auth and plan errors fail immediately.
- **No usable evidence from the selected pages:** visit the next-ranked candidates once.
- **Search stopped by a block or rate limit:** never worked around (no engine, proxy or region switching). The search span is marked failed and the result shows a warning explaining why it is thin or empty.

### Live progress

The web UI shows each step of a running investigation as it happens: searches, pages read or lost, evidence extracted, hypothesis board polarity totals, the model call and its validated result, follow-up questions and recoveries. Steps are reported by the pipeline itself through a per-request `AsyncLocalStorage` listener and streamed as NDJSON; nothing is simulated or timed. The finished result keeps the full log under "Investigation activity".

## What it does

1. Accept vehicle, diagnostic codes, and symptoms/context.
2. Construct technical research queries from the case.
3. Use the Solari browser/research layer (DuckDuckGo search and source-page extraction) to collect relevant sources.
4. Extract structured evidence (title, URL, finding) from visited pages.
5. Build a competing hypothesis board (ignition, fuel, mechanical, air-management/EGR, electrical/wiring).
6. Deterministically classify each evidence mention’s polarity as:
   - `supports`
   - `contradicts`
   - `context`
7. Convert unresolved assessment questions into bounded follow-up research objectives (at most one optional second research round; at most three follow-up objectives).
8. Rebuild the hypothesis board from the combined evidence.
9. Call the local Ollama/Qwen reasoning provider to produce a schema-constrained, validated structured assessment.
10. Present hypotheses, evidence (with polarity), unknowns, and a recommended next diagnostic test.

The deterministic evidence-polarity layer (`evaluateEvidence` / hypothesis-board mentions) is authoritative for `supports` / `contradicts` / `context`. The LLM is instructed to respect those labels and must not reclassify them. Assessment output is validated against the supplied evidence store (for example, cited URLs must exist in collected evidence).

## Architecture

```text
User input
    ↓
Research queries
    ↓
Solari / browser research
    ↓
Evidence extraction
    ↓
Hypothesis board
    ↓
Deterministic evidence polarity
    ↓
Follow-up research (bounded, optional round 2)
    ↓
Validated Qwen assessment
    ↓
CLI / Web tester
```

Application code lives under `autotrace/`:

| Path | Role |
| --- | --- |
| `autotrace/src/agent/` | Investigation orchestration (`runInvestigation`), including the two-round research bound |
| `autotrace/src/browser/` | Solari session helpers for search engines and source-page text extraction |
| `autotrace/src/research/` | Query construction, search, ranking, evidence extraction, follow-up execution |
| `autotrace/src/reasoning/` | Hypothesis board, deterministic mention polarity, follow-up planning |
| `autotrace/src/llm/` | Ollama and LiteLLM providers, prompts, JSON schema constraint, assessment parsing/validation, LLM tracing |
| `autotrace/src/config/` | Neatlogs tracing setup |
| `autotrace/src/ui/` | Local HTTP tester (form → shared pipeline → mapped UI result) |
| `autotrace/src/types/` | Shared TypeScript types |
| `autotrace/tests/` | Deterministic unit tests (no live network required) |

CLI entry: `autotrace/src/index.ts`. Web tester entry: `autotrace/src/ui/server.ts`. Both call the same `runInvestigation` pipeline.

## Requirements

- **Node.js** and **npm** (no specific Node version is pinned in the repository)
- **Solari API key** (`SOLARI_API_KEY`) for browser research
- **[Ollama](https://ollama.com)** running locally for reasoning
- **Qwen model** used by default: `qwen3:4b` (overridable via `OLLAMA_MODEL`)

Runtime dependencies (see `autotrace/package.json`): `@solarisdk/browser`, `dotenv`, `neatlogs`. Dev tooling: `tsx`, `typescript`, `@types/node`.

## Setup

PowerShell (from the repository root):

```powershell
cd autotrace
npm install
```

Create `autotrace/.env` (do not commit secrets):

```env
SOLARI_API_KEY=
```

Optional overrides:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:4b
PORT=3000

# Hosted reasoning through a LiteLLM gateway instead of local Ollama
AUTOTRACE_LLM=litellm
LITELLM_API_KEY=
LITELLM_MODEL=claude-sonnet-4.6

# Neatlogs tracing (export is disabled without a key)
NEATLOGS_API_KEY=
```

- `AUTOTRACE_LLM` — `ollama` (default) or `litellm`
- `LITELLM_API_KEY`, `LITELLM_MODEL`, `LITELLM_BASE_URL` — hosted provider settings; the base URL defaults to the neatHack gateway
- `NEATLOGS_API_KEY` — sends investigation traces to Neatlogs

- `SOLARI_API_KEY` — required for live research (Solari browser sessions)
- `OLLAMA_BASE_URL` — defaults to `http://localhost:11434`
- `OLLAMA_MODEL` — defaults to `qwen3:4b`
- `PORT` — web tester listen port; defaults to `3000`

Install and pull the default model with Ollama:

```powershell
ollama pull qwen3:4b
```

Ensure the Ollama service is running before CLI or UI investigations that reach the assessment step.

## Running the CLI

```powershell
cd autotrace
npm start
```

Runs the shared investigation pipeline for a hardcoded demonstration case (Mercedes-Benz C240 W203 with misfire / EGR-related codes) and prints the hypothesis board, evidence polarity, follow-up metadata when applicable, and the structured assessment to the console.

## Running the web tester

```powershell
cd autotrace
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The tester accepts dynamic:

- vehicle
- diagnostic codes
- symptoms / additional context

`POST /api/investigate` parses the form, then calls the same `runInvestigation` pipeline used by the CLI. The UI does not reimplement research or reasoning logic.

Live investigations can take several minutes (browser research plus model inference). The page shows each real step as it happens and offers light and dark themes (system default, with a toggle in the header).

## Example

A realistic case shape already used by the project and UI placeholders:

- **Vehicle:** Mercedes-Benz C240 W203
- **Codes:** P0305, P0400
- **Symptoms:** Cylinder 5 misfire. Previous ignition and injector swaps did not move the misfire.

Research results and assessments vary with available web sources and model output. Do not treat any single run as a fixed diagnosis.

## Testing

From `autotrace/`:

```powershell
npm test
npm run typecheck
```

- `npm test` — Node’s test runner over the deterministic suites (assessment parsing, evidence polarity, follow-up planning/execution, investigation loop, UI input mapping, and related helpers). Suites inject fakes so they do not require Solari or Ollama.
- `npm run typecheck` — `tsc --noEmit` for application and test TypeScript projects.

Verified on the `neathack` branch: **128 tests passed**, **0 failed**; typecheck exited successfully.

## Safety and limitations

- Research quality depends on what web sources return for a given query.
- Forum and community evidence can be incomplete or anecdotal.
- The system can return insufficient evidence; that is a valid outcome.
- Follow-up research is intentionally bounded (maximum two research rounds; limited follow-up objectives).
- Local Qwen reasoning produces a structured assessment of collected evidence; it is not a confirmed vehicle diagnosis.
- Physical inspection and manufacturer / service-manual procedures remain required.
- AutoTrace should support diagnostic reasoning, not replace qualified diagnosis or professional judgment.

## Project status

Technical research-agent prototype / demo for investigating automotive DTCs with browser research, deterministic evidence polarity, and local structured LLM assessment.

Not production-ready.

## Development principles

- Simple TypeScript (strict mode)
- Small, focused modules with clear layer boundaries
- Deterministic validation where practical (polarity rules, assessment schema parsing, investigation bounds)
- Minimal dependencies; ask before adding libraries
- CLI and UI share the same investigation pipeline

## License

MIT. See [LICENSE](LICENSE).
