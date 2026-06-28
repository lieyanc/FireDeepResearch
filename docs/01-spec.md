# FireDeepResearch Initial Spec

## Current Product Decisions

- Main language: TypeScript.
- Runtime: Node.js 22.
- Package manager: pnpm.
- Agent runtime: `@earendil-works/pi-agent-core`.
- Model abstraction: `@earendil-works/pi-ai`.
- Backend: Hono.
- Frontend: React + Vite.
- UI style: shadcn/ui native style, dense and practical rather than marketing-heavy.
- Realtime: Server-Sent Events first.
- Durable storage: hierarchical Markdown files plus JSONL event journals.
- Search/fetch providers: Exa, Tavily, Firecrawl.
- Not included initially: database, Playwright, extreme SSR, Temporal/Ray/Celery.

## Proposed Repository Layout

```text
apps/
  api/
    src/
      index.ts
      routes/
      runs/
      sse/
  web/
    src/
      app/
      components/
      features/
      lib/

packages/
  agent-runtime/
    src/
      pi-agent-adapter.ts
      role-runner.ts
      context-builder.ts
  research-core/
    src/
      controller.ts
      scheduler.ts
      phases.ts
      room-events.ts
  providers/
    src/
      exa.ts
      tavily.ts
      firecrawl.ts
      types.ts
  knowledge/
    src/
      markdown-store.ts
      artifact-writer.ts
      memory-loader.ts
      local-index.ts
  schemas/
    src/
      artifacts.ts
      events.ts
      run.ts

knowledge/
  global/
  domains/
  runs/
```

## Runtime Architecture

```text
User Message
  -> API creates ResearchRun
  -> ResearchRoomController initializes run folder
  -> Root user input saved as Markdown artifact
  -> Planner creates research DAG
  -> Scheduler launches parallel agent tasks
  -> Providers fetch/search sources
  -> Agents write Markdown artifacts
  -> SSE streams events to frontend
  -> Writer creates final report from linked artifacts
```

The controller is responsible for orchestration. Pi is used inside role turns as the LLM/tool execution runtime.

## Research Run Lifecycle

### Phase 0: Initialize

- Create `knowledge/runs/<run-id>/`.
- Write `00_user_input.md`.
- Write initial `events.jsonl`.
- Load relevant global and domain memory.

### Phase 1: Plan

Planner creates:

- Research goal.
- Subquestions.
- Search angles.
- Expected evidence types.
- Risk areas.
- Initial agent task graph.

### Phase 2: Parallel Search

Search agents run in parallel across providers and angles:

- Exa semantic search.
- Tavily web/news coverage.
- Firecrawl crawl or fetch for selected URLs.

Each search result is normalized into source candidates.

### Phase 3: Parallel Reading

Reader agents process source candidates:

- Extract useful quotes.
- Summarize source relevance.
- Score freshness and source type.
- Write `sources/source-xxx.md`.

### Phase 4: Claim Extraction

Claim agents convert evidence into structured claims:

- Facts.
- Numbers.
- Dates.
- Causal claims.
- Forecasts.
- Judgments.

Each claim links to supporting evidence.

### Phase 5: Adversarial Inquiry

Skeptic and question agents run against claims and emerging insights:

- Challenge unsupported claims.
- Ask missing-evidence questions.
- Identify contradictions.
- Request targeted follow-up searches.

This phase may loop back to search and reading.

### Phase 6: Insight Mining

Insight Miner looks for:

- Cross-source tension.
- Weak signals.
- Under-discussed implications.
- High-novelty hypotheses.

Insights must include evidence links and open verification questions.

### Phase 7: Citation Audit

Auditor checks:

- Whether cited evidence supports the exact claim.
- Whether source quality is acceptable.
- Whether opposing evidence exists.
- Whether confidence should be downgraded.

### Phase 8: Report

Writer produces `final_report.md` using only audited artifacts.

The report should preserve uncertainty and link important paragraphs to claims, sources, questions, and insights.

## Default Parallelism

Initial defaults:

```ts
export const DEFAULT_LIMITS = {
  maxConcurrentLlmCalls: 8,
  maxSearchAgents: 6,
  maxReaderAgents: 10,
  maxCritiqueAgents: 4,
  maxProviderRequestsPerProvider: 4,
};
```

Use `p-limit` for local concurrency control and `Promise.allSettled` for fault-tolerant batches.

Failure principle: one failing provider or agent should degrade the run, not kill it.

## Agent Roles

### Planner

Creates the research plan and decides what evidence is needed.

### Search Strategist

Generates search queries and assigns them to providers.

### Source Reader

Reads fetched content and extracts evidence.

### Claim Extractor

Turns source evidence into precise claims.

### Skeptic

Challenges claims, asks follow-up questions, and requests missing evidence.

### Insight Miner

Synthesizes non-obvious hypotheses from evidence tension.

### Citation Auditor

Checks whether citations actually support claims.

### Report Writer

Writes the final answer from audited artifacts only.

## Message-native Agent Context

Each role turn receives a generated context package:

```text
<root_user_input>
...
</root_user_input>

<current_run_state>
...
</current_run_state>

<relevant_memory>
...
</relevant_memory>

<blackboard>
...
</blackboard>

<task>
...
</task>
```

The goal is to maximize shared context without stuffing the full run into every call.

Context builder responsibilities:

- Always include root user input.
- Include current task and role instruction.
- Include recent events.
- Include relevant artifacts by links, tags, and frontmatter.
- Summarize older blackboard state when context grows.

## Markdown Knowledge Layout

```text
knowledge/
  global/
    user_preferences.md
    source_reputation.md
    research_playbook.md
    recurring_lessons.md

  domains/
    <domain-slug>/
      map.md
      trusted_sources.md
      open_questions.md
      important_claims.md

  runs/
    <run-id>/
      00_user_input.md
      01_research_plan.md
      02_blackboard.md
      events.jsonl
      sources/
      claims/
      questions/
      critiques/
      insights/
      audits/
      final_report.md
```

## Artifact Schemas

### Source

```md
---
id: source-001
type: source
provider: exa
url: https://example.com
title: Example
source_kind: primary
freshness: 2026-06-01
credibility: 0.82
tags: [ai-agents, enterprise]
created_at: 2026-06-28T00:00:00.000Z
---

# Summary

...

# Key Quotes

...
```

### Claim

```md
---
id: claim-001
type: claim
claim_kind: fact
status: challenged
confidence: 0.71
sources: [source-001, source-002]
opposes: []
tags: [market, enterprise]
created_at: 2026-06-28T00:00:00.000Z
---

# Claim

...

# Supporting Evidence

...

# Challenges

...
```

### Question

```md
---
id: question-001
type: question
target: claim-001
severity: high
question_kind: missing_evidence
status: open
created_at: 2026-06-28T00:00:00.000Z
---

# Question

...
```

### Insight

```md
---
id: insight-001
type: insight
confidence: medium
novelty: high
evidence_density: low
needs_verification: true
sources: [source-003, source-008]
created_at: 2026-06-28T00:00:00.000Z
---

# Insight

...

# Why It Matters

...

# Verification Questions

...
```

## Source Confidence

Source credibility should combine:

- Source kind: official, primary, academic, regulatory, media, blog, forum.
- Freshness.
- Author or organization transparency.
- Citation quality.
- Independence from other sources.
- Historical user feedback.
- Agreement with high-quality sources.
- Risk flags such as SEO spam, thin content, or vendor-only narrative.

Store evolving reputation in:

```text
knowledge/global/source_reputation.md
knowledge/domains/<domain>/trusted_sources.md
```

## Human Feedback

Frontend should allow rating:

- Source usefulness.
- Source credibility.
- Claim correctness.
- Citation support quality.
- Insight usefulness.
- Report usefulness.

Feedback writes Markdown snippets into the relevant artifact and optionally updates global memory.

## API Sketch

```http
POST /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
GET  /api/runs/:runId/artifacts
GET  /api/runs/:runId/artifacts/:artifactId
POST /api/runs/:runId/feedback
POST /api/runs/:runId/continue
POST /api/runs/:runId/cancel
```

`GET /api/runs/:runId/events` uses SSE.

## Event Types

```ts
type ResearchEvent =
  | { type: "run.created"; runId: string }
  | { type: "agent.started"; runId: string; agent: string; taskId: string }
  | { type: "agent.message.delta"; runId: string; agent: string; text: string }
  | { type: "tool.started"; runId: string; tool: string; taskId: string }
  | { type: "tool.finished"; runId: string; tool: string; taskId: string }
  | { type: "artifact.created"; runId: string; artifactId: string; path: string }
  | { type: "claim.challenged"; runId: string; claimId: string; questionId: string }
  | { type: "insight.created"; runId: string; insightId: string }
  | { type: "run.finished"; runId: string };
```

## Frontend Product Shape

Use React + Vite and shadcn/ui components. The app should feel like a research cockpit:

- Left rail: run list, domain memory, provider status.
- Main pane: live research timeline and final report.
- Right pane: selected artifact detail, evidence, critiques, feedback.
- Top bar: query, run status, model/provider cost, concurrency state.
- Tabs: Report, Claims, Sources, Questions, Insights, Audit.

Important UI behaviors:

- Click a report paragraph to reveal linked claims and sources.
- Click a claim to reveal evidence, challenges, and audit status.
- Show parallel agents as live task cards.
- Let the user upvote/downvote source, claim, citation, and insight quality.
- Avoid landing-page layout. The first screen should be the actual research cockpit.

## Configuration

Environment variables:

```text
FDR_API_PORT=8787
FDR_DATA_DIR=./knowledge
FDR_USE_MOCK_PROVIDERS=auto
FDR_MAX_SEARCH_AGENTS=6
FDR_MAX_READER_AGENTS=10
FDR_MAX_CRITIQUE_AGENTS=4
FDR_PROVIDER_TIMEOUT_MS=20000
FDR_PROVIDER_RETRY_ATTEMPTS=2
FDR_PROVIDER_RETRY_DELAY_MS=400
FDR_LLM_PROVIDER=
FDR_LLM_MODEL=
EXA_API_KEY=
TAVILY_API_KEY=
FIRECRAWL_API_KEY=
VITE_API_URL=http://localhost:8787
```

Pi model provider credentials, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, Azure OpenAI, Mistral, Groq, or OpenRouter keys, are loaded by `@earendil-works/pi-ai` according to the selected model provider.

Commercial provider calls use per-attempt timeout and retry settings. Search/fetch failures are emitted as structured tool events with an error message, and the run continues with partial evidence unless all later stages have no usable artifacts.

## MVP Milestones

### Milestone 1: Markdown artifact store

- Create run folders.
- Write/read artifacts.
- Append JSONL events.
- Build local in-memory index from Markdown frontmatter.

### Milestone 2: Provider adapters

- Exa search.
- Tavily search.
- Firecrawl fetch/crawl.
- Normalize results into source artifacts.

### Milestone 3: Pi role runner

- Wrap `pi-agent-core`.
- Implement context builder.
- Implement role prompts for Planner, Reader, Skeptic, Auditor, Insight Miner.

### Milestone 4: Research controller

- Run phase pipeline.
- Add parallel scheduler.
- Stream SSE events.
- Support degraded provider failures.

### Milestone 5: Frontend cockpit

- Run creation.
- Live event stream.
- Artifact browser.
- Report with linked evidence panel.
- Feedback controls.

## Open Questions

- Should each role have a different default model, or should model routing be configurable per run?
- How aggressive should the critique loop be before speed suffers?
- How should we summarize blackboard state when context grows too large?
- Should user feedback immediately mutate source reputation, or wait for a curator step?
- What is the minimum artifact schema needed for a strong hackathon demo?
