# FireDeepResearch Idea

## One-liner

FireDeepResearch is an auditable DeepResearch agent where every important conclusion is backed by traceable Markdown evidence, challenged by adversarial agents, and refined through reusable research memory.

## Product Positioning

Most research agents optimize for producing a polished report. FireDeepResearch should optimize for producing a reliable research process:

- What was searched?
- Which sources were used?
- Which claims were extracted?
- Which claims were challenged?
- Which questions remain unresolved?
- Which insights came from cross-source tension rather than summary?
- Which parts did the user trust or reject?

The final report is only one view over the research room. The core asset is the auditable evidence and reasoning trail.

## Primary Goals

- High depth: ask follow-up questions, pursue contradictions, and dig beyond first-page search results.
- High accuracy: require evidence-backed claims, citation audits, and explicit uncertainty.
- High speed: run search, reading, critique, and auditing agents in parallel by default.
- High traceability: store sources, claims, critiques, insights, and reports as linked Markdown artifacts.
- High leverage memory: reuse global lessons, domain maps, source reputation, and prior user feedback.
- Strong demo value: show the live multi-agent room, not only the final answer.

## Differentiators

### Shared-context multi-agent research

Agents do not operate as disconnected chat sessions. A research run starts from the original user message and maintains a shared blackboard. Each agent turn receives:

- Original user input.
- Current research goal.
- Latest blackboard summary.
- Relevant Markdown memory.
- Current task instruction.
- Evidence and claim links relevant to that turn.

This keeps agents aligned while still allowing specialization and parallelism.

### Markdown-native knowledge layer

No database in the initial design. Markdown is the durable source of truth.

The system writes structured Markdown artifacts with YAML frontmatter, then builds temporary in-memory indexes when needed. This keeps research inspectable, editable, portable, and demo-friendly.

### Adversarial inquiry loop

The system should not stop after "search and summarize." It should include explicit questioning:

- What would make this claim false?
- Is this supported by primary evidence?
- Are sources independent or repeating the same narrative?
- What missing data would change the conclusion?
- Are there weak signals that imply a different interpretation?

### Insight mining

A dedicated insight agent looks for non-obvious patterns:

- Cross-source contradictions.
- Gaps between official positioning and user behavior.
- Weak signals from hiring, pricing, docs, customer complaints, or integration ecosystems.
- Strategic implications that are not directly stated by any single source.

Insights are not treated as facts by default. They are hypotheses with evidence, novelty, confidence, and open verification questions.

### Human feedback loop

Users can rate:

- Whether a source is useful or trustworthy.
- Whether a claim is correct.
- Whether a citation supports the claim.
- Whether an insight is valuable.
- Whether the final report answered the actual question.

This feedback becomes Markdown memory and influences future source ranking, critique focus, and report style.

## Demo Story

Example query:

> Research the 2026 AI coding agent market and identify which startups have the strongest enterprise opportunity.

The UI should show:

- A live research room with multiple agents working in parallel.
- Search shards from Exa, Tavily, and Firecrawl.
- Source cards with credibility scores.
- Claim cards linked to source quotes.
- Skeptic questions attached to claims.
- Insight cards showing non-obvious hypotheses.
- Final report where key paragraphs link back to evidence and critique.

The strongest demo moment:

> Click any conclusion in the report and see the exact evidence, supporting sources, opposing sources, confidence, critique history, and user feedback.

## Non-goals For Initial Version

- No database.
- No Playwright or browser automation.
- No heavy SSR framework dependency.
- No generic chatbot UI as the main product surface.
- No opaque RAG store that hides where information came from.
- No overbuilt distributed workflow engine before the agent loop is proven.

## Working Slogan

DeepResearch you can audit.

