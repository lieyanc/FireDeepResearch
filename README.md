# FireDeepResearch

FireDeepResearch is a Markdown-native, auditable DeepResearch agent focused on depth, accuracy, speed, and original insight.

The project direction is:

- Use Pi harness packages as the agent runtime and multi-model abstraction layer.
- Use shared message context instead of isolated agent silos.
- Use hierarchical Markdown as the durable knowledge layer.
- Use Exa, Tavily, and Firecrawl for source discovery and extraction.
- Use adversarial multi-agent inquiry to challenge claims and surface non-obvious insights.
- Use a shadcn/ui-style React app for a practical research cockpit, without optimizing around heavy SSR.

Initial planning docs:

- [Idea](./docs/00-idea.md)
- [Spec](./docs/01-spec.md)
- [Completion Audit](./docs/02-completion-audit.md)

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Then open:

- Web cockpit: http://localhost:5173
- API health: http://localhost:8787/api/health

The default `.env.example` uses `FDR_USE_MOCK_PROVIDERS=auto`: with no Exa/Tavily key it runs a zero-key mock demo, and with commercial keys it uses the configured providers. The API health endpoint reports active search/fetch providers, the Pi/fallback LLM runtime, and effective research concurrency limits.

## Runtime Configuration

Key environment variables:

| Variable | Purpose |
| --- | --- |
| `FDR_API_PORT` | Hono API port, default `8787`. |
| `FDR_DATA_DIR` | Markdown knowledge root, default `./knowledge`. |
| `FDR_USE_MOCK_PROVIDERS` | `auto`, `true`, or `false` provider selection. |
| `FDR_CORS_ORIGIN` | Optional comma-separated API browser origin allowlist. Empty allows localhost/127.0.0.1 dev origins. |
| `FDR_MAX_SEARCH_AGENTS` | Parallel search task budget, 1-64. |
| `FDR_MAX_READER_AGENTS` | Parallel source reading budget, 1-64. |
| `FDR_MAX_CRITIQUE_AGENTS` | Parallel skeptic/audit budget, 1-64. |
| `FDR_PROVIDER_TIMEOUT_MS` | Per-attempt Exa/Tavily/Firecrawl timeout, 1000-120000 ms. |
| `FDR_PROVIDER_RETRY_ATTEMPTS` | Retry attempts for transient provider failures, 0-5. |
| `FDR_PROVIDER_RETRY_DELAY_MS` | Linear retry delay base, 0-10000 ms. |
| `FDR_LLM_MODEL` / `FDR_LLM_PROVIDER` | Pi model selection. Empty values use deterministic fallback output. |
| `FDR_REQUIRE_LIVE_SMOKE` | `true` makes live smoke fail when required provider/model credentials are missing. |
| `FDR_LOCAL_SMOKE_OUT_DIR` | Directory for retained `pnpm smoke:local` Chrome screenshots/events, default `/tmp/fdr-local-smoke-ui`. |
| `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY` | Commercial discovery and extraction providers. |
| `VITE_API_URL` | Web app API target, default `http://localhost:8787`. |

Pi model provider credentials are read by `@earendil-works/pi-ai`; common keys are included in `.env.example`.
Provider errors are recorded in the SSE event log and the run continues with whatever sources were collected.

## Implemented MVP

- TypeScript pnpm workspace with React/Vite web app and Hono API.
- Side-effect-free Hono API app factory separated from server startup, with isolated route integration tests.
- Pi-based role runner abstraction using `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, with deterministic fallback when no model is configured.
- API and cockpit runtime status for search/fetch providers, Pi model selection, fallback mode, and concurrency limits.
- Markdown-first knowledge layer with run folders, YAML frontmatter, JSONL event journals, feedback artifacts, and a local frontmatter index for artifact lookup.
- Atomic Markdown artifact, blackboard, run metadata, and global memory writes to avoid partial reads during live SSE refresh.
- Event journal reads tolerate malformed or partial JSONL lines so one damaged event does not break run history or SSE replay.
- Optional domain-scoped runs that load domain Markdown memory and preserve domain metadata through the run lifecycle.
- Provider adapters for Exa, Tavily, and Firecrawl, plus mock adapters for local demos.
- Research controller with staged multi-agent pipeline: planner, search strategist, search, source reader, claim extractor, skeptic, insight miner, citation auditor, report writer.
- Role turns receive shared context packages with the root input, run state, memory, recent events, indexed artifact inventory, explicit task instructions, task-specific artifacts, and a blackboard view that summarizes older sections while preserving recent state.
- Default parallel execution for search, reading, critique, and audit phases.
- Follow-up deep-dive continuation from a selected question or artifact, producing additional sources, claims, audits, and a focused follow-up report.
- Continuation validation that rejects missing question artifacts before changing run state.
- Automatic question-driven deep-dive pass during initial runs, using generated challenges to launch bounded corroboration and counter-evidence searches before final synthesis.
- Human feedback artifacts that write review snippets back into target artifacts, with source feedback updating global reputation and domain trusted-source memory, and non-source feedback becoming reusable user preference memory.
- Run-level quality audit summaries with source mix, average credibility, claim status, risk flags, and recommended next actions.
- Citation audit artifacts that link each audited claim to open questions and opposing or qualifying evidence candidates.
- Evidence Ledger artifacts that connect claims, sources, challenges, audits, quotes, and insights in a trace matrix.
- Cross-check contradiction matrices that mark claim independence, corroboration gaps, and opposing signals.
- Memory Update artifacts and global recurring lessons that capture reusable research experience after each run.
- SSE event streaming for live run and artifact create/update events, including agent/tool duration telemetry.
- Graceful run cancellation that records `cancelled` status instead of treating user aborts as failures.
- shadcn-style research cockpit with run list, domain/global memory preview, run-level telemetry, live stream status, live room timeline, artifact tabs, evidence detail panel, body-reference artifact chips, related-artifact navigation, and dimensioned feedback controls.

## Verification

Run the standard local verifier:

```bash
pnpm verify
```

It expands to:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:api
pnpm smoke:local
pnpm smoke:live
git diff --check
```

Run the isolated API smoke to start a temporary mock-provider API, create a run, verify artifacts/events/report feedback/source feedback, assert the final report plus evidence ledger, contradiction matrix, quality audit, auto deep-dive artifacts, successful question continuation, and clean up its temporary data directory:

```bash
pnpm smoke:api
```

With the local API and web dev servers running, run the lightweight Chrome UI smoke without adding Playwright:

```bash
pnpm smoke:ui
```

To test the browser cockpit without relying on already-running services, start temporary mock API and Web servers, seed a mock run, submit report feedback through Chrome, click a `source-001` artifact chip, submit source feedback, and run the UI smoke against them. This is the browser check used by `pnpm verify`; screenshots and browser event logs are retained under `FDR_LOCAL_SMOKE_OUT_DIR`:

```bash
pnpm smoke:local
```

When live credentials are available, run commercial provider and Pi model smoke checks:

```bash
pnpm smoke:live
```

The live smoke scripts load the root `.env` file automatically, matching the API startup path, so credentials can be supplied either through the shell environment or by editing `.env`.

To inspect live acceptance readiness without making provider/model network calls, run:

```bash
pnpm smoke:live:readiness
```

Set `FDR_REQUIRE_LIVE_SMOKE=true` to fail instead of skipping missing live credentials. In strict mode, readiness reports the exact missing provider/model environment variables before network smoke checks run.
For final live-key acceptance, use:

```bash
pnpm verify:strict-live
```

For live Pi model verification, configure either `FDR_LLM_MODEL=provider/model` or `FDR_LLM_PROVIDER=provider` with `FDR_LLM_MODEL=model`. `FDR_LLM_PROVIDER` takes priority when set, so model ids may contain slashes, for example `FDR_LLM_PROVIDER=openrouter` and `FDR_LLM_MODEL=anthropic/claude-sonnet-4`.

Smoke-tested with `FDR_USE_MOCK_PROVIDERS=true` by creating a run through the API and verifying generated Markdown artifacts.
Also smoke-tested `/api/runs/:runId/continue` from a generated question, follow-up report/memory creation, and feedback persistence into `source_reputation`, domain `trusted_sources`, and `user_preferences` memory.
