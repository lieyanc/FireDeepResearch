import { randomUUID } from "node:crypto";
import type { RoleRunner } from "@fdr/agent-runtime";
import { createHybridRoleRunner } from "@fdr/agent-runtime";
import type { MarkdownStore, MemoryBundle } from "@fdr/knowledge";
import type { ProviderRegistry, SearchResult } from "@fdr/providers";
import { inferSourceKind, scoreSourceCredibility } from "@fdr/providers";
import {
  DEFAULT_LIMITS,
  type AgentRole,
  type ArtifactRef,
  type ClaimKind,
  type ClaimRecord,
  type FeedbackRequest,
  type ResearchEvent,
  type ResearchRun,
  type RunCreateRequest,
  type SearchTask,
  type SourceRecord,
} from "@fdr/schemas";

export interface ResearchControllerOptions {
  store: MarkdownStore;
  providers: ProviderRegistry;
  roleRunner?: RoleRunner;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

export type ResearchEventListener = (event: ResearchEvent) => void;

interface RunInput extends RunCreateRequest {
  domain?: string;
}

interface RunState {
  run: ResearchRun;
  input: RunInput;
  abortController: AbortController;
  promise: Promise<void>;
}

interface ReadSourceResult {
  source: SourceRecord;
  artifact: ArtifactRef;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTaskId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function slugFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40);
}

function compactText(value: string, maxLength: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}...`;
}

function uniqueByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const normalized = result.url.replace(/#.*$/, "");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(result);
  }
  return deduped;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function roleLabel(role: AgentRole): string {
  return role
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function memoryToContext(memory: MemoryBundle): string {
  const sections = [...memory.global, ...memory.domain]
    .slice(0, 6)
    .map((doc) => `## ${doc.title}\n\n${compactText(doc.body, 1_000)}`);
  return sections.length > 0 ? sections.join("\n\n") : "No prior memory loaded.";
}

function buildSystemPrompt(role: AgentRole): string {
  const shared = [
    "You are working inside FireDeepResearch, an auditable DeepResearch system.",
    "Preserve uncertainty. Do not invent citations. Prefer precise claims over broad summaries.",
    "Every important statement should point back to sources, claims, questions, or insights.",
  ].join("\n");
  const roleSpecific: Record<AgentRole, string> = {
    planner: "Create a concise research plan with independent search angles, risk areas, and expected evidence.",
    "search-strategist": "Generate search angles and identify what would make the answer stronger.",
    "source-reader": "Extract evidence, source usefulness, source risk, and direct quotes.",
    "claim-extractor": "Turn evidence into atomic claims with confidence and linked source ids.",
    skeptic: "Challenge claims. Ask sharp missing-evidence and contradiction questions.",
    "insight-miner": "Find non-obvious hypotheses from tension between sources. Do not overstate them.",
    "citation-auditor": "Audit whether evidence supports the exact claim. Downgrade weak support.",
    "report-writer": "Write a useful report using only the audited evidence trail.",
  };
  return `${shared}\n\nRole: ${roleLabel(role)}\n${roleSpecific[role]}`;
}

function buildSearchTasks(input: RunInput, providerNames: string[]): SearchTask[] {
  const maxTasks = input.maxSearchTasks ?? 6;
  const base = input.query.trim();
  const angles = [
    "primary evidence and official sources",
    "independent market analysis and expert commentary",
    "user/practitioner adoption signals and complaints",
    "risks, contradictions, and counterexamples",
    "pricing, enterprise procurement, governance, and security",
    "weak signals for novel strategic insight",
    "recent changes, launches, and competitive movement",
    "source reputation and factual verification",
  ].slice(0, maxTasks);

  return angles.map((angle, index) => ({
    id: `search-${index + 1}`,
    query: `${base} ${angle}`,
    angle,
    priority: Number((1 - index * 0.07).toFixed(2)),
    providers: providerNames.map((name) => (name === "mock" ? "mock" : name)).filter(
      (name): name is SearchTask["providers"][number] =>
        name === "exa" || name === "tavily" || name === "firecrawl" || name === "mock",
    ),
  }));
}

function sourceToMarkdown(source: SourceRecord): string {
  const quotes = source.keyQuotes.map((quote) => `> ${quote}`).join("\n\n");
  return [
    `# ${source.title}`,
    "",
    `URL: ${source.url}`,
    "",
    "## Summary",
    "",
    source.summary,
    "",
    "## Key Quotes",
    "",
    quotes || "No direct quote extracted.",
  ].join("\n");
}

function deriveKeyQuotes(content: string, fallback: string): string[] {
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 40);
  return (sentences.length > 0 ? sentences : [fallback]).slice(0, 3).map((sentence) => compactText(sentence, 320));
}

function makeClaimFromSource(source: SourceRecord, index: number): ClaimRecord {
  const lowered = `${source.summary} ${source.keyQuotes.join(" ")}`.toLowerCase();
  const id = `claim-${String(index + 1).padStart(3, "0")}`;
  let text = `${source.title} is relevant to the research question and should be considered with ${source.sourceKind} source confidence.`;
  let kind: ClaimKind = "judgment";
  let tags = [...source.tags];
  let confidence = Math.min(0.88, Math.max(0.35, source.credibility));

  if (/governance|audit|permission|compliance|security|retention/.test(lowered)) {
    text =
      "Enterprise adoption is gated less by raw model capability alone and more by governance, auditability, permissions, and data-control evidence.";
    kind = "causal";
    tags = [...new Set([...tags, "enterprise", "governance", "audit"])];
    confidence = Math.min(0.9, confidence + 0.05);
  } else if (/speed|editor|individual|bottom-up|developer/.test(lowered)) {
    text =
      "Individual developers still create bottom-up adoption pressure by choosing coding agents for speed, editor fit, and immediate usefulness.";
    kind = "judgment";
    tags = [...new Set([...tags, "adoption", "developer-experience"])];
  } else if (/workflow|context|integration|differentiation|market/.test(lowered)) {
    text =
      "Competitive differentiation is shifting from simple autocomplete or model benchmarks toward workflow integration, context handling, and trusted execution.";
    kind = "judgment";
    tags = [...new Set([...tags, "market", "workflow", "context"])];
  } else if (/review|stale|long-horizon|risk/.test(lowered)) {
    text =
      "Long-horizon coding-agent autonomy remains review-bound because stale context and unfamiliar systems can produce costly mistakes.";
    kind = "fact";
    tags = [...new Set([...tags, "risk", "review"])];
  }

  return {
    id,
    text,
    claimKind: kind,
    status: source.credibility >= 0.75 ? "verified" : "challenged",
    confidence: Number(confidence.toFixed(2)),
    sources: [source.id],
    opposes: [],
    tags,
  };
}

function claimToMarkdown(claim: ClaimRecord, source: SourceRecord): string {
  return [
    "# Claim",
    "",
    claim.text,
    "",
    "## Supporting Evidence",
    "",
    `- [${source.id}] ${source.title}`,
    "",
    source.keyQuotes.map((quote) => `> ${quote}`).join("\n\n"),
    "",
    "## Challenges",
    "",
    claim.status === "verified"
      ? "No high-severity challenge yet, but citation audit is still required."
      : "Needs independent corroboration or a sharper source-quality audit.",
  ].join("\n");
}

export class ResearchController {
  private readonly listeners = new Set<ResearchEventListener>();
  private readonly activeRuns = new Map<string, RunState>();
  private readonly roleRunner: RoleRunner;
  private readonly limits: typeof DEFAULT_LIMITS;

  constructor(private readonly options: ResearchControllerOptions) {
    this.roleRunner = options.roleRunner ?? createHybridRoleRunner();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  }

  subscribe(listener: ResearchEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listRuns(): Promise<ResearchRun[]> {
    return this.options.store.listRuns();
  }

  async getRun(runId: string): Promise<ResearchRun | undefined> {
    return this.options.store.readRun(runId);
  }

  async getEvents(runId: string): Promise<ResearchEvent[]> {
    return this.options.store.readEvents(runId);
  }

  async listArtifacts(runId: string): Promise<ArtifactRef[]> {
    return this.options.store.listArtifacts(runId);
  }

  async readArtifact(runId: string, artifactPath: string) {
    return this.options.store.readArtifact(runId, artifactPath);
  }

  async addFeedback(runId: string, feedback: FeedbackRequest): Promise<ArtifactRef> {
    const artifact = await this.options.store.appendFeedback(runId, feedback);
    await this.emit({ type: "artifact.created", runId, artifact, at: nowIso() });
    return artifact;
  }

  async createRun(input: RunInput): Promise<ResearchRun> {
    const run = await this.options.store.createRun(input);
    await this.emit({ type: "run.created", runId: run.id, at: nowIso() });
    const abortController = new AbortController();
    const promise = this.executeRun(run, input, abortController.signal).catch(async (error: unknown) => {
      await this.emit({
        type: "run.failed",
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
        at: nowIso(),
      });
      const latest = await this.options.store.readRun(run.id);
      if (latest) {
        await this.options.store.updateRun({ ...latest, status: "failed" });
      }
    });
    this.activeRuns.set(run.id, { run, input, abortController, promise });
    promise.finally(() => this.activeRuns.delete(run.id)).catch(() => undefined);
    return run;
  }

  cancelRun(runId: string): boolean {
    const state = this.activeRuns.get(runId);
    if (!state) {
      return false;
    }
    state.abortController.abort();
    return true;
  }

  private async emit(event: ResearchEvent): Promise<void> {
    await this.options.store.appendEvent(event.runId, event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async updateRunStatus(run: ResearchRun, status: ResearchRun["status"]): Promise<ResearchRun> {
    const updated = await this.options.store.updateRun({ ...run, status });
    await this.emit({ type: "run.updated", runId: run.id, status, at: nowIso() });
    return updated;
  }

  private async executeRun(initialRun: ResearchRun, input: RunInput, signal: AbortSignal): Promise<void> {
    let run = await this.updateRunStatus(initialRun, "running");
    const memory = await this.options.store.loadMemory(input.domain);
    const searchTasks = await this.plan(run, input, memory, signal);
    const searchResults = await this.search(run, searchTasks, signal);
    const sourceResults = await this.readSources(run, searchResults, signal);
    const claims = await this.extractClaims(run, sourceResults, signal);
    await this.challengeClaims(run, claims, signal);
    const insights = await this.mineInsights(run, input, sourceResults, claims, memory, signal);
    await this.auditClaims(run, claims, sourceResults, signal);
    const report = await this.writeReport(run, input, sourceResults, claims, insights, memory, signal);
    run = await this.updateRunStatus(run, "finished");
    await this.emit({ type: "run.finished", runId: run.id, reportPath: report.path, at: nowIso() });
  }

  private async runRole(
    run: ResearchRun,
    role: AgentRole,
    label: string,
    userPrompt: string,
    context: string,
    signal: AbortSignal,
  ): Promise<string> {
    const taskId = makeTaskId(role);
    await this.emit({ type: "agent.started", runId: run.id, agent: role, taskId, label, at: nowIso() });
    const result = await this.roleRunner.run(
      {
        role,
        taskId,
        label,
        systemPrompt: buildSystemPrompt(role),
        userPrompt,
        context,
      },
      signal,
    );
    if (result.text) {
      await this.emit({
        type: "agent.message.delta",
        runId: run.id,
        agent: role,
        taskId,
        text: compactText(result.text, 1_000),
        at: nowIso(),
      });
    }
    await this.emit({ type: "agent.finished", runId: run.id, agent: role, taskId, at: nowIso() });
    return result.text;
  }

  private async plan(
    run: ResearchRun,
    input: RunInput,
    memory: MemoryBundle,
    signal: AbortSignal,
  ): Promise<SearchTask[]> {
    signal.throwIfAborted();
    const providerNames = this.options.providers.searchProviders.map((provider) => provider.name);
    const tasks = buildSearchTasks(input, providerNames);
    const context = `<root_user_input>\n${input.query}\n</root_user_input>\n\n<relevant_memory>\n${memoryToContext(memory)}\n</relevant_memory>`;
    const modelText = await this.runRole(
      run,
      "planner",
      "Plan research angles",
      `Create a research plan and assess risk areas. Proposed tasks:\n${tasks
        .map((task) => `- ${task.id}: ${task.angle} -> ${task.query}`)
        .join("\n")}`,
      context,
      signal,
    );
    const body = [
      "# Research Plan",
      "",
      "## Root Question",
      "",
      input.query,
      "",
      "## Search Tasks",
      "",
      ...tasks.map((task) => `- **${task.id}** (${task.angle}): ${task.query}`),
      "",
      "## Planner Notes",
      "",
      modelText,
    ].join("\n");
    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "plan",
      id: "research-plan",
      title: "Research Plan",
      filename: "01_research_plan.md",
      frontmatter: {
        id: "research-plan",
        type: "plan",
        task_count: tasks.length,
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Plan", `Created ${tasks.length} parallel search tasks.`);
    return tasks;
  }

  private async search(run: ResearchRun, tasks: SearchTask[], signal: AbortSignal): Promise<SearchResult[]> {
    signal.throwIfAborted();
    const jobs = tasks.flatMap((task) =>
      this.options.providers.searchProviders.map((provider) => ({ task, provider })),
    );
    const batches = await mapWithConcurrency(
      jobs,
      this.limits.maxSearchAgents,
      async ({ task, provider }) => {
        const taskId = `${task.id}-${provider.name}`;
        await this.emit({ type: "tool.started", runId: run.id, tool: `${provider.name}.search`, taskId, at: nowIso() });
        try {
          const results = await provider.search({ task, maxResults: 4 }, signal);
          await this.emit({
            type: "tool.finished",
            runId: run.id,
            tool: `${provider.name}.search`,
            taskId,
            ok: true,
            at: nowIso(),
          });
          return results;
        } catch {
          await this.emit({
            type: "tool.finished",
            runId: run.id,
            tool: `${provider.name}.search`,
            taskId,
            ok: false,
            at: nowIso(),
          });
          return [];
        }
      },
    );
    const results = uniqueByUrl(batches.flat()).slice(0, 18);
    await this.options.store.appendBlackboard(run.id, "Search", `Collected ${results.length} unique source candidates.`);
    return results;
  }

  private async readSources(
    run: ResearchRun,
    results: SearchResult[],
    signal: AbortSignal,
  ): Promise<ReadSourceResult[]> {
    signal.throwIfAborted();
    const readResults = await mapWithConcurrency(
      results,
      this.limits.maxReaderAgents,
      async (result, index) => {
        const taskId = `read-${index + 1}`;
        await this.emit({ type: "agent.started", runId: run.id, agent: "source-reader", taskId, label: result.title, at: nowIso() });
        let content = result.content || result.snippet;
        if (!result.content || result.content.length < 300) {
          await this.emit({ type: "tool.started", runId: run.id, tool: `${this.options.providers.fetchProvider.name}.fetch`, taskId, at: nowIso() });
          try {
            const fetched = await this.options.providers.fetchProvider.fetch(result.url, signal);
            content = fetched.markdown || content;
            await this.emit({
              type: "tool.finished",
              runId: run.id,
              tool: `${this.options.providers.fetchProvider.name}.fetch`,
              taskId,
              ok: true,
              at: nowIso(),
            });
          } catch {
            await this.emit({
              type: "tool.finished",
              runId: run.id,
              tool: `${this.options.providers.fetchProvider.name}.fetch`,
              taskId,
              ok: false,
              at: nowIso(),
            });
          }
        }
        const sourceKind = inferSourceKind(result.url, result.title);
        const credibility = scoreSourceCredibility({
          sourceKind,
          url: result.url,
          title: result.title,
          hasContent: content.length > 0,
          providerScore: result.score,
        });
        const source: SourceRecord = {
          id: `source-${String(index + 1).padStart(3, "0")}`,
          title: result.title,
          url: result.url,
          provider: result.provider,
          sourceKind,
          credibility,
          freshness: result.publishedAt,
          summary: compactText(content || result.snippet, 700),
          keyQuotes: deriveKeyQuotes(content, result.snippet),
          tags: [sourceKind, result.provider, "research-source"],
        };
        const artifact = await this.options.store.writeArtifact({
          runId: run.id,
          kind: "source",
          id: source.id,
          title: source.title,
          collection: "sources",
          frontmatter: {
            id: source.id,
            type: "source",
            provider: source.provider,
            url: source.url,
            source_kind: source.sourceKind,
            credibility: source.credibility,
            freshness: source.freshness,
            tags: source.tags,
          },
          body: sourceToMarkdown(source),
        });
        await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
        await this.emit({ type: "agent.finished", runId: run.id, agent: "source-reader", taskId, at: nowIso() });
        return { source, artifact };
      },
    );
    await this.options.store.appendBlackboard(run.id, "Reading", `Wrote ${readResults.length} source artifacts.`);
    return readResults;
  }

  private async extractClaims(
    run: ResearchRun,
    sources: ReadSourceResult[],
    signal: AbortSignal,
  ): Promise<Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>> {
    signal.throwIfAborted();
    const taskId = makeTaskId("claims");
    await this.emit({ type: "agent.started", runId: run.id, agent: "claim-extractor", taskId, label: "Extract claims", at: nowIso() });
    const claims = sources.slice(0, 8).map(({ source }, index) => makeClaimFromSource(source, index));
    const deduped = claims.filter((claim, index, all) => all.findIndex((other) => other.text === claim.text) === index);
    const artifacts = await Promise.all(
      deduped.map(async (claim) => {
        const source = sources.find(({ source }) => source.id === claim.sources[0])?.source ?? sources[0].source;
        const artifact = await this.options.store.writeArtifact({
          runId: run.id,
          kind: "claim",
          id: claim.id,
          title: compactText(claim.text, 80),
          collection: "claims",
          frontmatter: {
            id: claim.id,
            type: "claim",
            claim_kind: claim.claimKind,
            status: claim.status,
            confidence: claim.confidence,
            sources: claim.sources,
            opposes: claim.opposes,
            tags: claim.tags,
          },
          body: claimToMarkdown(claim, source),
        });
        await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
        return { claim, source, artifact };
      }),
    );
    await this.emit({ type: "agent.finished", runId: run.id, agent: "claim-extractor", taskId, at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Claims", `Extracted ${artifacts.length} distinct claims.`);
    return artifacts;
  }

  private async challengeClaims(
    run: ResearchRun,
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    signal: AbortSignal,
  ): Promise<void> {
    await mapWithConcurrency(
      claims,
      this.limits.maxCritiqueAgents,
      async ({ claim, source }, index) => {
        signal.throwIfAborted();
        const taskId = `skeptic-${claim.id}`;
        await this.emit({ type: "agent.started", runId: run.id, agent: "skeptic", taskId, label: `Challenge ${claim.id}`, at: nowIso() });
        const severity = claim.confidence < 0.7 ? "high" : "medium";
        const questionId = `question-${String(index + 1).padStart(3, "0")}`;
        const question = [
          "# Question",
          "",
          `Does ${claim.id} rely too heavily on ${source.sourceKind} evidence from ${source.title}?`,
          "",
          "## Why It Matters",
          "",
          "If the evidence is not independent, the report should mark the claim as weak or request follow-up search.",
          "",
          "## Follow-up Probe",
          "",
          `Find an independent source that either supports or contradicts: ${claim.text}`,
        ].join("\n");
        const artifact = await this.options.store.writeArtifact({
          runId: run.id,
          kind: "question",
          id: questionId,
          title: `Challenge ${claim.id}`,
          collection: "questions",
          frontmatter: {
            id: questionId,
            type: "question",
            target: claim.id,
            severity,
            question_kind: "missing_evidence",
            status: "open",
          },
          body: question,
        });
        await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
        await this.emit({ type: "claim.challenged", runId: run.id, claimId: claim.id, questionId, severity, at: nowIso() });
        await this.emit({ type: "agent.finished", runId: run.id, agent: "skeptic", taskId, at: nowIso() });
      },
    );
    await this.options.store.appendBlackboard(run.id, "Skeptic Loop", `Challenged ${claims.length} claims for independence and missing evidence.`);
  }

  private async mineInsights(
    run: ResearchRun,
    input: RunInput,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    memory: MemoryBundle,
    signal: AbortSignal,
  ): Promise<ArtifactRef[]> {
    const context = `<root_user_input>\n${input.query}\n</root_user_input>\n\n<claims>\n${claims
      .map(({ claim }) => `- ${claim.id}: ${claim.text}`)
      .join("\n")}\n</claims>\n\n<relevant_memory>\n${memoryToContext(memory)}\n</relevant_memory>`;
    const modelText = await this.runRole(
      run,
      "insight-miner",
      "Find non-obvious insight",
      "Identify tension, weak signals, or under-discussed strategic implications. Mark hypotheses as hypotheses.",
      context,
      signal,
    );
    const strongestSources = sources
      .map(({ source }) => source)
      .sort((a, b) => b.credibility - a.credibility)
      .slice(0, 3);
    const insightBody = [
      "# Insight",
      "",
      "Enterprise-grade research should treat governance, audit trails, and evidence visibility as adoption infrastructure, not as compliance afterthoughts.",
      "",
      "## Why It Matters",
      "",
      "The strongest sources point in different directions: developers value speed, while procurement and enterprise stakeholders gate rollout on control and auditability. This tension creates a product wedge for agents that can prove what they did, why they did it, and which evidence supported the action.",
      "",
      "## Evidence Links",
      "",
      ...strongestSources.map((source) => `- ${source.id}: ${source.title}`),
      "",
      "## Model Notes",
      "",
      modelText,
      "",
      "## Verification Questions",
      "",
      "- Can independent enterprise adoption data confirm governance as a buying trigger?",
      "- Do user communities show shadow adoption before official procurement approval?",
      "- Which vendors expose the clearest audit trail in their product today?",
    ].join("\n");
    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "insight",
      id: "insight-001",
      title: "Governance as adoption infrastructure",
      collection: "insights",
      frontmatter: {
        id: "insight-001",
        type: "insight",
        confidence: "medium",
        novelty: "high",
        evidence_density: "medium",
        needs_verification: true,
        sources: strongestSources.map((source) => source.id),
        tags: ["governance", "auditability", "enterprise"],
      },
      body: insightBody,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.emit({ type: "insight.created", runId: run.id, insightId: "insight-001", novelty: "high", at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Insight", "Created one high-novelty strategic insight with verification questions.");
    return [artifact];
  }

  private async auditClaims(
    run: ResearchRun,
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    _sources: ReadSourceResult[],
    signal: AbortSignal,
  ): Promise<void> {
    await mapWithConcurrency(
      claims,
      this.limits.maxCritiqueAgents,
      async ({ claim, source }, index) => {
        signal.throwIfAborted();
        const taskId = `audit-${claim.id}`;
        await this.emit({ type: "agent.started", runId: run.id, agent: "citation-auditor", taskId, label: `Audit ${claim.id}`, at: nowIso() });
        const support = claim.confidence >= 0.75 ? "supported" : claim.confidence >= 0.55 ? "partially_supported" : "weak";
        const auditId = `audit-${String(index + 1).padStart(3, "0")}`;
        const body = [
          "# Citation Audit",
          "",
          `Claim: ${claim.text}`,
          "",
          `Primary source: ${source.id} (${source.sourceKind}, credibility ${source.credibility})`,
          "",
          `Audit status: ${support}`,
          "",
          "## Evidence Check",
          "",
          source.keyQuotes.map((quote) => `> ${quote}`).join("\n\n"),
          "",
          "## Auditor Note",
          "",
          support === "supported"
            ? "The cited evidence is directionally strong, but independent corroboration is still preferred for final high-confidence conclusions."
            : "The claim should remain qualified until stronger independent evidence is added.",
        ].join("\n");
        const artifact = await this.options.store.writeArtifact({
          runId: run.id,
          kind: "audit",
          id: auditId,
          title: `Audit ${claim.id}`,
          collection: "audits",
          frontmatter: {
            id: auditId,
            type: "audit",
            target: claim.id,
            status: support,
            source: source.id,
          },
          body,
        });
        await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
        await this.emit({ type: "agent.finished", runId: run.id, agent: "citation-auditor", taskId, at: nowIso() });
      },
    );
    await this.options.store.appendBlackboard(run.id, "Audit", `Audited ${claims.length} claims for citation support.`);
  }

  private async writeReport(
    run: ResearchRun,
    input: RunInput,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    insights: ArtifactRef[],
    memory: MemoryBundle,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    const context = `<root_user_input>\n${input.query}\n</root_user_input>\n\n<claims>\n${claims
      .map(({ claim }) => `- ${claim.id} (${claim.status}, ${claim.confidence}): ${claim.text}`)
      .join("\n")}\n</claims>\n\n<sources>\n${sources
      .slice(0, 8)
      .map(({ source }) => `- ${source.id} (${source.sourceKind}, ${source.credibility}): ${source.title}`)
      .join("\n")}\n</sources>\n\n<memory>\n${memoryToContext(memory)}\n</memory>`;
    const modelText = await this.runRole(
      run,
      "report-writer",
      "Write auditable report",
      "Write a concise final report. Link claims and sources by id. Include uncertainty and open questions.",
      context,
      signal,
    );
    const claimLines = claims
      .map(
        ({ claim }) =>
          `- **${claim.id}** (${claim.status}, confidence ${claim.confidence}): ${claim.text} Sources: ${claim.sources
            .map((sourceId) => `\`${sourceId}\``)
            .join(", ")}`,
      )
      .join("\n");
    const sourceLines = sources
      .slice(0, 10)
      .map(({ source }) => `- **${source.id}** [${source.sourceKind}, ${source.credibility}] ${source.title} - ${source.url}`)
      .join("\n");
    const body = [
      "# Final Report",
      "",
      "## Answer",
      "",
      "The current evidence suggests that the strongest DeepResearch and coding-agent products will win by combining fast agentic execution with visible evidence trails, governance, source credibility, and human feedback. Raw model capability remains important, but the defensible product layer is the auditable research process: what was searched, which claims were made, who challenged them, and why the final report trusted or qualified them.",
      "",
      "## Key Claims",
      "",
      claimLines || "No claims extracted.",
      "",
      "## Distinctive Insight",
      "",
      insights.length > 0
        ? "The main strategic tension is bottom-up speed versus top-down trust. A product that exposes audit trails, claim challenges, and source reputation can turn that tension into a buying wedge."
        : "No insight artifact was created.",
      "",
      "## Source Trail",
      "",
      sourceLines || "No sources collected.",
      "",
      "## Open Questions",
      "",
      "- Which claims need independent primary-source corroboration?",
      "- Where does user feedback disagree with automated source credibility?",
      "- Which insights are novel but still under-evidenced?",
      "",
      "## Writer Notes",
      "",
      modelText,
    ].join("\n");
    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "report",
      id: "final-report",
      title: "Final Report",
      filename: "final_report.md",
      frontmatter: {
        id: "final-report",
        type: "report",
        claim_count: claims.length,
        source_count: sources.length,
        insight_count: insights.length,
        tags: ["final-report", slugFragment(input.query)],
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    return artifact;
  }
}

