# FireDeepResearch Completion Audit

Last updated: 2026-06-29

This audit maps the current project against the idea/spec documents. It is intentionally evidence-based: green tests or code presence only count when they cover the stated requirement.

## Current Status

FireDeepResearch is a working MVP with a Markdown-native research pipeline, mock zero-key demo mode, commercial provider adapters, Hono API, React cockpit, SSE event stream, follow-up continuations, feedback memory, and auditable artifact traces.

The project should not yet be marked fully complete until live-key provider/model smoke tests have been run in an environment with those capabilities.

## Requirement Evidence

| Requirement | Status | Current evidence |
| --- | --- | --- |
| TypeScript pnpm workspace with React/Vite web and Hono API | Proven | `pnpm build`, `pnpm smoke:api`, package manifests, `apps/web`, `apps/api` |
| Markdown artifact store with run folders, frontmatter, JSONL events, local index | Proven | `packages/knowledge/src/index.ts`, `packages/knowledge/src/index.test.ts` |
| Event journal tolerates malformed JSONL | Proven | knowledge tests cover malformed event replay |
| Atomic writes for Markdown/run/memory state | Proven | knowledge implementation and tests for no temp-file residue |
| API app factory separated from server startup | Proven | `createApiApp`, `apps/api/src/index.test.ts`, and `pnpm smoke:api` |
| Run-scoped API validation and missing-run checks | Proven | API route tests cover artifacts, event history, SSE, feedback, cancel |
| Bounded user input before Markdown paths/memory | Proven | schema tests and API tests cover query/domain/prompt/artifact id/note |
| Exa/Tavily/Firecrawl adapters plus mock providers | Partly proven | provider unit tests cover normalization and retry behavior; `pnpm smoke:live:providers` is available but live commercial calls need real keys |
| Provider failures degrade runs instead of killing all work | Proven by unit/integration behavior | provider retry tests and research-core failure-path tests |
| Pi role runner abstraction with deterministic fallback | Proven for fallback | agent-runtime tests cover fallback, Pi model-load fallback, abort handling; `pnpm smoke:live:llm` is available but live Pi model call needs credentials |
| Shared role context with root input, run state, memory, artifacts, events, task block | Proven | research-core context tests inspect generated continuation context |
| Parallel search/reading/critique/audit phases | Proven by implementation and events | research-core tests cover event emission and generated artifact sets |
| Planner plus Search Strategist | Proven | research-core tests assert Search Strategy Notes |
| Source reading with credibility/reputation scoring | Proven | provider, knowledge, research-core tests cover source scoring and source reputation |
| Claim extraction and challenge questions | Proven | research-core pipeline tests assert claim/question artifacts and challenged events |
| Automatic bounded deep dive loop | Proven | research-core tests assert deep dive events/artifacts/final report metadata; `pnpm smoke:api` checks the auto-deep-dive request and final report section |
| Citation audits with open questions and opposing evidence | Proven | research-core tests inspect audit body/frontmatter |
| Evidence ledger and contradiction matrix | Proven | research-core tests assert generated artifacts for initial and auto deep dive phases; `pnpm smoke:api` checks ledger trace content and contradiction verdicts |
| Memory update and recurring lessons | Proven | research-core and knowledge tests cover memory artifacts/global lessons |
| Follow-up continuation from generated questions | Proven | research-core and API tests cover continuation and missing-question validation; `pnpm smoke:api` starts a generated-question continuation and verifies follow-up report plus continuation memory |
| Human feedback writes artifacts and updates memory/reputation | Proven | knowledge, research-core, API tests, and `pnpm smoke:api` cover target snippets, source reputation, domain trusted sources, user preferences |
| SSE streaming with run/artifact/agent/tool events | Proven for API and browser behavior | API tests cover history/SSE missing run; research-core tests cover event types and durations; `pnpm smoke:local` waits for the cockpit stream status to become live |
| Cancellation records `cancelled`, not `failed` | Proven | research-core cancellation tests and API missing-cancel tests |
| React cockpit first screen, no landing page | Proven | `pnpm smoke:local` and `pnpm smoke:ui` headless Chrome desktop/mobile checks, plus local HTTP 200 |
| Cockpit run list, memory preview, provider/model status, telemetry, live stream status, timeline, tabs, evidence panel | Proven for mock/local mode | `apps/web/src/App.tsx`, web build/test, and `pnpm smoke:local` |
| Artifact id chips and related artifact navigation | Proven | `apps/web/src/artifactRefs.ts`, `apps/web/src/MarkdownView.tsx`, and `apps/web/src/App.test.tsx` cover generated artifact id and frontmatter relationship recognition; `pnpm smoke:local` clicks a report `source-001` chip and waits for source detail |
| Feedback controls for dimensions and notes | Proven for mock/local mode | `pnpm smoke:local` seeds a temporary run, drives Chrome to submit report feedback, navigate to a source artifact, submit source feedback, and verify the updated artifact body; API/backend tests cover memory persistence |

## Verification Commands

Current green checks:

```bash
pnpm verify
```

`pnpm verify` expands to:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:api
pnpm smoke:local
pnpm smoke:live
git diff --check
```

Current local service checks:

```bash
curl -sS http://localhost:8787/api/health
curl -sS -I http://localhost:5173/
pnpm smoke:local
```

`pnpm smoke:api` starts an isolated mock-provider API with temporary `FDR_DATA_DIR`, creates a run, verifies generated artifacts/events, checks final report auto-deep-dive metadata, evidence ledger trace content, contradiction verdicts, quality-audit next actions, rejects unsafe domain/artifact ids, writes report and source feedback, verifies user preferences/source reputation/domain trusted-source memory, starts a successful generated-question continuation, verifies follow-up report and continuation memory, observes update/continuation events, and cleans up unless `FDR_API_SMOKE_KEEP_DATA=true` is set.
`pnpm smoke:ui` uses headless Google Chrome CDP to render desktop and mobile cockpit states, writes screenshots to `/tmp/fdr-ui-smoke`, verifies no horizontal overflow, and confirms no runtime/browser log errors.
`pnpm smoke:local` starts temporary mock API and Vite web servers on isolated ports, points the web app at that API via `VITE_API_URL`, seeds a mock run, drives Chrome through report feedback, artifact-chip navigation to `source-001`, source feedback, waits for updated artifact bodies, retains screenshots/browser event logs under `FDR_LOCAL_SMOKE_OUT_DIR` (default `/tmp/fdr-local-smoke-ui`), and removes temporary run data by default. It is the self-contained local browser acceptance path used by `pnpm verify`.
`pnpm smoke:live:readiness` performs a no-network readiness audit for Exa/Tavily/Firecrawl and Pi model credentials, reporting exact missing environment variables and failing in strict mode.
`pnpm smoke:live` runs live readiness, then Exa/Tavily/Firecrawl and Pi model smoke checks when credentials are configured; with no credentials it exits successfully with an explicit skip message unless `FDR_REQUIRE_LIVE_SMOKE=true` is set. The live smoke scripts load the root `.env` file automatically, matching the API startup path.
`pnpm verify:strict-live` runs the full verifier with `FDR_REQUIRE_LIVE_SMOKE=true` for final live-key acceptance.
`.env.example` documents the live smoke knobs and provider/model credential variables.

## Remaining Completion Risks

- Live Exa/Tavily/Firecrawl verification requires commercial keys; adapter behavior is unit-tested and repeatable readiness/live smoke commands exist, but this environment has no keys configured.
- Live Pi model verification requires model credentials; fallback/model-load failure behavior is tested and repeatable readiness/live smoke commands exist, but this environment has no model/key configured.
- The UI cockpit is still dense, but artifact-reference parsing and Markdown rendering have been split into focused modules. Further component extraction can wait until behavior is frozen.

## Next Best Actions

1. Run `pnpm verify:strict-live` when provider/model credentials are available.
2. Optionally run a small end-to-end API research run with live providers and a temporary `FDR_DATA_DIR`.
3. After those evidence gaps are closed, perform a final requirement-by-requirement audit before marking the project complete.
