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

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Then open:

- Web cockpit: http://localhost:5173
- API health: http://localhost:8787/api/health

The default `.env.example` uses `FDR_USE_MOCK_PROVIDERS=auto`: with no Exa/Tavily key it runs a zero-key mock demo, and with commercial keys it uses the configured providers. The API health endpoint reports active search/fetch providers and effective research concurrency limits.

## Runtime Configuration

Key environment variables:

| Variable | Purpose |
| --- | --- |
| `FDR_API_PORT` | Hono API port, default `8787`. |
| `FDR_DATA_DIR` | Markdown knowledge root, default `./knowledge`. |
| `FDR_USE_MOCK_PROVIDERS` | `auto`, `true`, or `false` provider selection. |
| `FDR_MAX_SEARCH_AGENTS` | Parallel search task budget, 1-64. |
| `FDR_MAX_READER_AGENTS` | Parallel source reading budget, 1-64. |
| `FDR_MAX_CRITIQUE_AGENTS` | Parallel skeptic/audit budget, 1-64. |
| `FDR_PROVIDER_TIMEOUT_MS` | Per-attempt Exa/Tavily/Firecrawl timeout, 1000-120000 ms. |
| `FDR_PROVIDER_RETRY_ATTEMPTS` | Retry attempts for transient provider failures, 0-5. |
| `FDR_PROVIDER_RETRY_DELAY_MS` | Linear retry delay base, 0-10000 ms. |
| `FDR_LLM_MODEL` / `FDR_LLM_PROVIDER` | Pi model selection. Empty values use deterministic fallback output. |
| `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY` | Commercial discovery and extraction providers. |
| `VITE_API_URL` | Web app API target, default `http://localhost:8787`. |

Pi model provider credentials are read by `@earendil-works/pi-ai`; common keys are included in `.env.example`.
Provider errors are recorded in the SSE event log and the run continues with whatever sources were collected.

## Implemented MVP

- TypeScript pnpm workspace with React/Vite web app and Hono API.
- Pi-based role runner abstraction using `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, with deterministic fallback when no model is configured.
- Markdown-first knowledge layer with run folders, YAML frontmatter, JSONL event journals, and feedback artifacts.
- Provider adapters for Exa, Tavily, and Firecrawl, plus mock adapters for local demos.
- Research controller with staged multi-agent pipeline: planner, search, source reader, claim extractor, skeptic, insight miner, citation auditor, report writer.
- Default parallel execution for search, reading, critique, and audit phases.
- Follow-up deep-dive continuation from a selected question or artifact, producing additional sources, claims, audits, and a focused follow-up report.
- Human feedback artifacts that update global Markdown source reputation memory and influence later source credibility scoring.
- Run-level quality audit summaries with source mix, average credibility, claim status, risk flags, and recommended next actions.
- Evidence Ledger artifacts that connect claims, sources, challenges, audits, quotes, and insights in a trace matrix.
- Cross-check contradiction matrices that mark claim independence, corroboration gaps, and opposing signals.
- Memory Update artifacts and global recurring lessons that capture reusable research experience after each run.
- SSE event streaming for live run updates.
- shadcn-style research cockpit with run list, live room timeline, artifact tabs, evidence detail panel, related-artifact navigation, and feedback controls.

## Verification

Current checks:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Smoke-tested with `FDR_USE_MOCK_PROVIDERS=true` by creating a run through the API and verifying the generated Markdown artifacts under `knowledge/runs`.
Also smoke-tested `/api/runs/:runId/continue` from a generated question and feedback persistence into `knowledge/global/source_reputation.md`.
