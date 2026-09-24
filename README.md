# AutoTrace Research Agent

AutoTrace is an automotive diagnostic research agent. Given a vehicle, diagnostic trouble codes (DTCs), and optional symptoms, it researches technical web sources via Solari cloud browsers, collects structured evidence, evaluates competing diagnostic hypotheses, runs a bounded follow-up research round when needed, and produces a validated structured diagnostic assessment through a local Ollama/Qwen model.

It is a research assistant for diagnostic reasoning, not a parts-replacement chatbot and not a confirmed vehicle diagnosis.

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
| `autotrace/src/llm/` | Ollama/Qwen provider, prompts, JSON schema constraint, assessment parsing/validation |
| `autotrace/src/ui/` | Local HTTP tester (form → shared pipeline → mapped UI result) |
| `autotrace/src/types/` | Shared TypeScript types |
| `autotrace/tests/` | Deterministic unit tests (no live network required) |

CLI entry: `autotrace/src/index.ts`. Web tester entry: `autotrace/src/ui/server.ts`. Both call the same `runInvestigation` pipeline.

## Requirements

- **Node.js** and **npm** (no specific Node version is pinned in the repository)
- **Solari API key** (`SOLARI_API_KEY`) for browser research
- **[Ollama](https://ollama.com)** running locally for reasoning
- **Qwen model** used by default: `qwen3:4b` (overridable via `OLLAMA_MODEL`)

Runtime dependencies (see `autotrace/package.json`): `@solarisdk/browser`, `dotenv`. Dev tooling: `tsx`, `typescript`, `@types/node`.

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
```

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

Live investigations can take several minutes (browser research plus local model inference).

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

Verified in the current workspace: **78 tests passed**, **0 failed**; typecheck exited successfully.

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
