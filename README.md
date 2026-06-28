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
FDR_USE_MOCK_PROVIDERS=true pnpm dev
```

Then open:

- Web cockpit: http://localhost:5173
- API health: http://localhost:8787/api/health

The mock provider mode runs without API keys and still exercises the full pipeline. To use commercial providers, copy `.env.example`, set the provider keys, and run with `FDR_USE_MOCK_PROVIDERS=false`.

## Implemented MVP

- TypeScript pnpm workspace with React/Vite web app and Hono API.
- Pi-based role runner abstraction using `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, with deterministic fallback when no model is configured.
- Markdown-first knowledge layer with run folders, YAML frontmatter, JSONL event journals, and feedback artifacts.
- Provider adapters for Exa, Tavily, and Firecrawl, plus mock adapters for local demos.
- Research controller with staged multi-agent pipeline: planner, search, source reader, claim extractor, skeptic, insight miner, citation auditor, report writer.
- Default parallel execution for search, reading, critique, and audit phases.
- Follow-up deep-dive continuation from a selected question or artifact, producing additional sources, claims, audits, and a focused follow-up report.
- Human feedback artifacts that also update global Markdown source reputation memory.
- SSE event streaming for live run updates.
- shadcn-style research cockpit with run list, live room timeline, artifact tabs, evidence detail panel, and feedback controls.

## Verification

Current checks:

```bash
pnpm build
pnpm test
```

Smoke-tested with `FDR_USE_MOCK_PROVIDERS=true` by creating a run through the API and verifying the generated Markdown artifacts under `knowledge/runs`.
Also smoke-tested `/api/runs/:runId/continue` from a generated question and feedback persistence into `knowledge/global/source_reputation.md`.
