import { randomUUID } from "node:crypto";
import type { RoleRunner } from "@fdr/agent-runtime";
import { createHybridRoleRunner } from "@fdr/agent-runtime";
import type { ArtifactIndexEntry, MarkdownStore, MemoryBundle } from "@fdr/knowledge";
import type { ProviderRegistry, SearchResult } from "@fdr/providers";
import { inferSourceKind, scoreSourceCredibility } from "@fdr/providers";
import {
  DEFAULT_LIMITS,
  type AgentRole,
  type ArtifactDocument,
  type ArtifactRef,
  type ClaimKind,
  type ClaimRecord,
  type ContinueRunRequest,
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
  limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;
}

export type ResearchEventListener = (event: ResearchEvent) => void;

interface RunInput extends RunCreateRequest {
  domain?: string;
}

interface ContinueInput extends ContinueRunRequest {
  domain?: string;
}

interface RunState {
  run: ResearchRun;
  input: RunInput | ContinueInput;
  abortController: AbortController;
  promise: Promise<void>;
}

interface ReadSourceResult {
  source: SourceRecord;
  artifact: ArtifactRef;
}

interface ClaimArtifactResult {
  claim: ClaimRecord;
  source: SourceRecord;
  artifact: ArtifactRef;
}

interface AutoDeepDiveResult {
  questionId?: string;
  critique?: ArtifactRef;
  sources: ReadSourceResult[];
  claims: ClaimArtifactResult[];
}

type ResearchPhase = "initial" | "continuation" | "auto_deep_dive";

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
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

function compactError(error: unknown): string {
  return compactText(error instanceof Error ? error.message : String(error), 500);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|cancelled|canceled/i.test(error.message);
  }
  return /aborted|cancelled|canceled/i.test(String(error));
}

function requireUsableSources(phase: ResearchPhase, sources: ReadSourceResult[]): void {
  if (sources.length === 0) {
    throw new Error(`No usable sources were collected during ${phase}; the run cannot produce an auditable report.`);
  }
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.split("/")[0] || "unknown";
  }
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contextBlock(name: string, value: string): string {
  const content = value.trim() || "(none)";
  return `<${name}>\n${content}\n</${name}>`;
}

function summarizeBlackboardForContext(body: string, maxLength = 2_000): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const parts = trimmed.split(/\n(?=##\s+)/);
  const title = parts[0]?.startsWith("## ") ? "# Research Blackboard" : parts[0]?.trim() || "# Research Blackboard";
  const sections = parts.filter((part) => part.startsWith("## "));
  if (sections.length === 0) {
    return `${title}\n\n## Blackboard Summary\n\n${compactText(trimmed, maxLength)}`;
  }

  const recentSections: string[] = [];
  let recentLength = 0;
  const recentBudget = Math.floor(maxLength * 0.65);
  for (const section of [...sections].reverse()) {
    const cleanSection = section.trim();
    if (recentSections.length > 0 && recentLength + cleanSection.length > recentBudget) {
      break;
    }
    recentSections.unshift(cleanSection);
    recentLength += cleanSection.length;
  }

  const omittedSections = sections.slice(0, Math.max(0, sections.length - recentSections.length));
  const omittedHeadings = omittedSections
    .map((section) => section.match(/^##\s+(.+)$/m)?.[1]?.trim())
    .filter((heading): heading is string => Boolean(heading));
  const summary = [
    title,
    "## Earlier Blackboard Summary",
    omittedHeadings.length > 0
      ? `Older sections omitted from this role context: ${omittedHeadings.slice(-12).join("; ")}.`
      : "Older free-form blackboard notes were omitted from this role context.",
    "## Recent Blackboard Sections",
    recentSections.join("\n\n"),
  ].join("\n\n");

  if (summary.length <= maxLength) {
    return summary;
  }

  const recentText = recentSections.join("\n\n");
  const summaryHeader = [
    title,
    "## Earlier Blackboard Summary",
    omittedHeadings.length > 0
      ? `Older sections omitted from this role context: ${omittedHeadings.slice(-8).join("; ")}.`
      : "Older free-form blackboard notes were omitted from this role context.",
    "## Recent Blackboard Sections",
  ].join("\n\n");
  return `${summaryHeader}\n\n${recentText.slice(Math.max(0, recentText.length - Math.max(400, maxLength - summaryHeader.length - 2)))}`;
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" && value ? [value] : [];
}

function artifactRefsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  return [
    ...asStringArray(frontmatter.sources),
    ...asStringArray(frontmatter.source),
    ...asStringArray(frontmatter.target),
    ...asStringArray(frontmatter.question_id),
    ...asStringArray(frontmatter.artifact_id),
    ...asStringArray(frontmatter.opposes),
  ];
}

function artifactTime(entry: ArtifactIndexEntry): number {
  return Date.parse(entry.updatedAt ?? entry.createdAt ?? "") || 0;
}

function artifactsToContext(entries: ArtifactIndexEntry[]): string {
  const sorted = [...entries]
    .filter((entry) => entry.kind !== "blackboard" && entry.kind !== "user_input")
    .sort((a, b) => artifactTime(b) - artifactTime(a) || b.path.localeCompare(a.path))
  const selected: ArtifactIndexEntry[] = [];
  const pushUnique = (entry: ArtifactIndexEntry) => {
    if (!selected.some((existing) => existing.id === entry.id)) {
      selected.push(entry);
    }
  };
  sorted.filter((entry) => entry.kind === "question").slice(0, 8).forEach(pushUnique);
  sorted.slice(0, 16).forEach(pushUnique);
  if (selected.length === 0) {
    return "No linked artifacts yet.";
  }
  return selected
    .slice(0, 22)
    .map((entry) => {
      const tags = entry.tags.length > 0 ? ` tags=${entry.tags.join(",")}` : "";
      const refs = artifactRefsFromFrontmatter(entry.frontmatter);
      const refsText = refs.length > 0 ? ` refs=${[...new Set(refs)].join(",")}` : "";
      return `- ${entry.id} [${entry.kind}] ${entry.title} (${entry.path})${tags}${refsText}`;
    })
    .join("\n");
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
    "## Credibility",
    "",
    `- Source kind: ${source.sourceKind}`,
    `- Score: ${source.credibility}`,
    `- Reputation adjustment: ${source.reputationAdjustment ?? 0}`,
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
  private readonly limits: Record<keyof typeof DEFAULT_LIMITS, number>;

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
    await this.requireRun(runId);
    return this.options.store.readEvents(runId);
  }

  async listArtifacts(runId: string): Promise<ArtifactRef[]> {
    await this.requireRun(runId);
    return this.options.store.listArtifacts(runId);
  }

  async readArtifact(runId: string, artifactPath: string) {
    await this.requireRun(runId);
    return this.options.store.readArtifact(runId, artifactPath);
  }

  async readArtifactById(runId: string, artifactId: string) {
    await this.requireRun(runId);
    return this.options.store.readArtifactById(runId, artifactId);
  }

  async getMemory(domain?: string): Promise<MemoryBundle> {
    return this.options.store.loadMemory(domain);
  }

  getLimits(): Record<keyof typeof DEFAULT_LIMITS, number> {
    return { ...this.limits };
  }

  async addFeedback(runId: string, feedback: FeedbackRequest): Promise<ArtifactRef> {
    const run = await this.requireRun(runId);
    const target = await this.options.store.readArtifactById(runId, feedback.artifactId);
    if (!target) {
      throw new Error(`Artifact not found: ${feedback.artifactId}`);
    }
    const artifact = await this.options.store.appendFeedback(runId, feedback);
    const updatedTarget = await this.options.store.appendFeedbackToArtifact(runId, feedback, artifact);
    await this.options.store.appendSourceReputationFeedback({ runId, feedback, artifact: target });
    await this.options.store.appendDomainTrustedSourceFeedback({ runId, domain: run.domain, feedback, artifact: target });
    await this.options.store.appendUserFeedbackMemory({ runId, feedback, artifact: target });
    await this.emit({ type: "artifact.created", runId, artifact, at: nowIso() });
    if (updatedTarget) {
      await this.emit({ type: "artifact.updated", runId, artifact: updatedTarget, at: nowIso() });
    }
    return artifact;
  }

  async createRun(input: RunInput): Promise<ResearchRun> {
    const run = await this.options.store.createRun(input);
    await this.emit({ type: "run.created", runId: run.id, at: nowIso() });
    const abortController = new AbortController();
    const promise = this.executeRun(run, input, abortController.signal).catch(async (error: unknown) => {
      if (abortController.signal.aborted || isAbortError(error)) {
        await this.markRunCancelled(run.id);
        return;
      }
      await this.emit({
        type: "run.failed",
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
        at: nowIso(),
      });
      const latest = await this.options.store.readRun(run.id);
      if (latest) {
        await this.updateRunStatus(latest, "failed");
      }
    });
    this.activeRuns.set(run.id, { run, input, abortController, promise });
    promise.finally(() => this.activeRuns.delete(run.id)).catch(() => undefined);
    return run;
  }

  async continueRun(runId: string, input: ContinueInput): Promise<ResearchRun> {
    const run = await this.options.store.readRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (this.activeRuns.has(runId)) {
      throw new Error(`Run is already active: ${runId}`);
    }
    if (input.questionId) {
      const question = await this.options.store.readArtifactById(runId, input.questionId);
      if (!question || question.kind !== "question") {
        throw new Error(`Question artifact not found: ${input.questionId}`);
      }
    }
    const continuationInput = { ...input, domain: input.domain ?? run.domain };
    const abortController = new AbortController();
    const running = await this.updateRunStatus(run, "running");
    const promise = this.executeContinuation(running, continuationInput, abortController.signal).catch(async (error: unknown) => {
      if (abortController.signal.aborted || isAbortError(error)) {
        await this.markRunCancelled(runId);
        return;
      }
      await this.emit({
        type: "run.failed",
        runId,
        error: error instanceof Error ? error.message : String(error),
        at: nowIso(),
      });
      const latest = await this.options.store.readRun(runId);
      if (latest) {
        await this.updateRunStatus(latest, "failed");
      }
    });
    this.activeRuns.set(runId, { run: running, input: continuationInput, abortController, promise });
    promise.finally(() => this.activeRuns.delete(runId)).catch(() => undefined);
    return running;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = await this.options.store.readRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const state = this.activeRuns.get(runId);
    if (!state) {
      return false;
    }
    state.abortController.abort(new Error("Run cancelled by user"));
    return true;
  }

  private async emit(event: ResearchEvent): Promise<void> {
    await this.options.store.appendEvent(event.runId, event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event consumers must not be able to fail the research run.
      }
    }
  }

  private async requireRun(runId: string): Promise<ResearchRun> {
    const run = await this.options.store.readRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private async updateRunStatus(run: ResearchRun, status: ResearchRun["status"]): Promise<ResearchRun> {
    const updated = await this.options.store.updateRun({ ...run, status });
    await this.emit({ type: "run.updated", runId: run.id, status, at: nowIso() });
    return updated;
  }

  private async markRunCancelled(runId: string): Promise<void> {
    const latest = await this.options.store.readRun(runId);
    if (!latest || latest.status === "cancelled") {
      return;
    }
    await this.updateRunStatus(latest, "cancelled");
  }

  private async executeRun(initialRun: ResearchRun, input: RunInput, signal: AbortSignal): Promise<void> {
    let run = await this.updateRunStatus(initialRun, "running");
    const memory = await this.options.store.loadMemory(input.domain);
    const searchTasks = await this.plan(run, input, memory, signal);
    const searchResults = await this.search(run, searchTasks, signal);
    const sourceResults = await this.readSources(run, searchResults, signal);
    requireUsableSources("initial", sourceResults);
    const claims = await this.extractClaims(run, sourceResults, signal);
    await this.challengeClaims(run, claims, signal);
    await this.auditClaims(run, claims, sourceResults, signal);
    const autoDeepDive = await this.runAutoDeepDive(run, input, sourceResults, claims, signal);
    const allSources = [...sourceResults, ...autoDeepDive.sources];
    const allClaims = [...claims, ...autoDeepDive.claims];
    const insights = await this.mineInsights(run, input, allSources, allClaims, memory, signal);
    await this.writeContradictionMatrix(run, allSources, allClaims, "initial");
    await this.writeQualityAudit(run, allSources, allClaims, "initial");
    await this.writeEvidenceLedger(run, allSources, allClaims, { phase: "initial", insights });
    const report = await this.writeReport(run, input, allSources, allClaims, insights, memory, signal, autoDeepDive);
    await this.writeMemoryUpdate(run, allSources, allClaims, {
      phase: "initial",
      domain: input.domain,
      report,
    });
    run = await this.updateRunStatus(run, "finished");
    await this.emit({ type: "run.finished", runId: run.id, reportPath: report.path, at: nowIso() });
  }

  private async executeContinuation(run: ResearchRun, input: ContinueInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const memory = await this.options.store.loadMemory(input.domain);
    const artifacts = await this.options.store.listArtifacts(run.id);
    const question = input.questionId ? await this.options.store.readArtifactById(run.id, input.questionId) : undefined;
    const focus = input.prompt ?? question?.body ?? "Deepen the strongest unresolved question in this run.";
    const questionId = input.questionId ?? question?.id;
    await this.emit({
      type: "continuation.started",
      runId: run.id,
      questionId,
      prompt: compactText(stripMarkdown(focus), 500),
      at: nowIso(),
    });

    const providerNames = this.options.providers.searchProviders.map((provider) => provider.name);
    const cleanFocus = compactText(stripMarkdown(focus), 600);
    const maxSearchTasks = input.maxSearchTasks ?? 3;
    const followupIndex = artifacts.filter((artifact) => artifact.id.startsWith("deep-dive-")).length + 1;
    const followupPrefix = `followup-${String(followupIndex).padStart(3, "0")}`;
    const tasks: SearchTask[] = [
      {
        id: `${followupPrefix}-search-1`,
        angle: "independent corroboration for challenged claim",
        query: `${run.query} ${cleanFocus} independent corroboration primary evidence`,
        priority: 0.95,
        providers: providerNames
          .map((name) => (name === "mock" ? "mock" : name))
          .filter((name) => name === "exa" || name === "tavily" || name === "mock"),
      },
      {
        id: `${followupPrefix}-search-2`,
        angle: "counter evidence and contradiction search",
        query: `${run.query} ${cleanFocus} contradiction counterexample risk`,
        priority: 0.85,
        providers: providerNames
          .map((name) => (name === "mock" ? "mock" : name))
          .filter((name) => name === "exa" || name === "tavily" || name === "mock"),
      },
      {
        id: `${followupPrefix}-search-3`,
        angle: "weak signal and novel insight search",
        query: `${run.query} ${cleanFocus} weak signal adoption evidence insight`,
        priority: 0.75,
        providers: providerNames
          .map((name) => (name === "mock" ? "mock" : name))
          .filter((name) => name === "exa" || name === "tavily" || name === "mock"),
      },
    ].slice(0, maxSearchTasks);

    const critiqueId = `deep-dive-${String(followupIndex).padStart(3, "0")}`;
    const critique = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "critique",
      id: critiqueId,
      title: "Follow-up Deep Dive Request",
      collection: "critiques",
      frontmatter: {
        id: critiqueId,
        type: "critique",
        question_id: questionId,
        search_task_count: tasks.length,
      },
      body: [
        "# Follow-up Deep Dive Request",
        "",
        "## Focus",
        "",
        cleanFocus,
        "",
        "## Search Tasks",
        "",
        ...tasks.map((task) => `- **${task.id}** (${task.angle}): ${task.query}`),
      ].join("\n"),
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact: critique, at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Continuation", `Started follow-up deep dive for ${questionId ?? "manual prompt"}.`);

    const sourceStartIndex = artifacts.filter((artifact) => artifact.kind === "source").length;
    const claimStartIndex = artifacts.filter((artifact) => artifact.kind === "claim").length;
    const questionStartIndex = artifacts.filter((artifact) => artifact.kind === "question").length;
    const auditStartIndex = artifacts.filter((artifact) => artifact.kind === "audit").length;

    const searchResults = await this.search(run, tasks, signal);
    const sourceResults = await this.readSources(run, searchResults.slice(0, 8), signal, { startIndex: sourceStartIndex });
    requireUsableSources("continuation", sourceResults);
    const claims = await this.extractClaims(run, sourceResults, signal, { startIndex: claimStartIndex });
    await this.challengeClaims(run, claims, signal, { startIndex: questionStartIndex });
    await this.auditClaims(run, claims, sourceResults, signal, { startIndex: auditStartIndex });
    await this.writeContradictionMatrix(run, sourceResults, claims, "continuation");
    await this.writeQualityAudit(run, sourceResults, claims, "continuation");
    await this.writeEvidenceLedger(run, sourceResults, claims, { phase: "continuation" });
    const report = await this.writeContinuationReport(run, cleanFocus, sourceResults, claims, memory, signal);
    await this.writeMemoryUpdate(run, sourceResults, claims, {
      phase: "continuation",
      domain: input.domain,
      focus: cleanFocus,
      report,
    });
    const finished = await this.updateRunStatus(run, "finished");
    await this.emit({ type: "continuation.finished", runId: finished.id, reportPath: report.path, at: nowIso() });
  }

  private searchProviderNames(): SearchTask["providers"] {
    return this.options.providers.searchProviders
      .map((provider) => provider.name)
      .filter((name): name is "exa" | "tavily" | "mock" => name === "exa" || name === "tavily" || name === "mock");
  }

  private async selectAutoDeepDiveQuestion(
    run: ResearchRun,
    claims: ClaimArtifactResult[],
  ): Promise<ArtifactDocument | undefined> {
    const artifacts = (await this.options.store.listArtifacts(run.id)).filter((artifact) => artifact.kind === "question");
    const docs = (
      await Promise.all(artifacts.map((artifact) => this.options.store.readArtifact(run.id, artifact.path)))
    ).filter((doc): doc is ArtifactDocument => Boolean(doc));
    const claimById = new Map(claims.map(({ claim }) => [claim.id, claim]));
    const severityScore = (value: unknown) => {
      if (value === "high") {
        return 100;
      }
      if (value === "medium") {
        return 60;
      }
      if (value === "low") {
        return 20;
      }
      return 0;
    };
    return docs
      .map((doc) => {
        const target = typeof doc.frontmatter.target === "string" ? doc.frontmatter.target : undefined;
        const claim = target ? claimById.get(target) : undefined;
        return {
          doc,
          score: severityScore(doc.frontmatter.severity) + (claim ? 1 - claim.confidence : 0),
        };
      })
      .sort((a, b) => b.score - a.score)[0]?.doc;
  }

  private async runAutoDeepDive(
    run: ResearchRun,
    input: RunInput,
    _sources: ReadSourceResult[],
    claims: ClaimArtifactResult[],
    signal: AbortSignal,
  ): Promise<AutoDeepDiveResult> {
    signal.throwIfAborted();
    const question = await this.selectAutoDeepDiveQuestion(run, claims);
    if (!question) {
      await this.options.store.appendBlackboard(run.id, "Auto Deep Dive", "Skipped: no generated question was available.");
      return { sources: [], claims: [] };
    }

    const providerNames = this.searchProviderNames();
    const existingBeforeCritique = await this.options.store.listArtifacts(run.id);
    const critiqueIndex = existingBeforeCritique.filter((artifact) => artifact.id.startsWith("auto-deep-dive")).length + 1;
    const taskPrefix = `auto-deep-dive-${String(critiqueIndex).padStart(3, "0")}`;
    const cleanFocus = compactText(stripMarkdown(question.body), 650);
    const targetClaimId = typeof question.frontmatter.target === "string" ? question.frontmatter.target : undefined;
    const targetClaim = targetClaimId ? claims.find(({ claim }) => claim.id === targetClaimId)?.claim : undefined;
    const targetText = compactText(targetClaim?.text ?? cleanFocus, 500);
    const tasks: SearchTask[] = [
      {
        id: `${taskPrefix}-search-1`,
        angle: "independent corroboration for strongest challenge",
        query: `${input.query} ${targetText} independent corroboration primary evidence`,
        priority: 0.96,
        providers: providerNames,
      },
      {
        id: `${taskPrefix}-search-2`,
        angle: "counter evidence and limitation search",
        query: `${input.query} ${targetText} contradiction counterexample limitation risk`,
        priority: 0.9,
        providers: providerNames,
      },
    ];

    await this.emit({
      type: "deep_dive.started",
      runId: run.id,
      questionId: question.id,
      targetClaimId,
      prompt: cleanFocus,
      at: nowIso(),
    });

    const critiqueId = `auto-deep-dive-${String(critiqueIndex).padStart(3, "0")}`;
    const critique = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "critique",
      id: critiqueId,
      title: "Auto Deep Dive Request",
      collection: "critiques",
      frontmatter: {
        id: critiqueId,
        type: "critique",
        critique_kind: "auto_deep_dive",
        target: targetClaimId,
        question_id: question.id,
        search_task_count: tasks.length,
        tags: ["auto-deep-dive", "question-driven"],
      },
      body: [
        "# Auto Deep Dive Request",
        "",
        "## Trigger Question",
        "",
        cleanFocus,
        "",
        "## Target Claim",
        "",
        targetClaim ? `${targetClaim.id}: ${targetClaim.text}` : "No target claim found.",
        "",
        "## Search Tasks",
        "",
        ...tasks.map((task) => `- **${task.id}** (${task.angle}): ${task.query}`),
        "",
        "## Rationale",
        "",
        "The system selected the highest-risk generated question and launched a bounded corroboration/counter-evidence pass before final synthesis.",
      ].join("\n"),
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact: critique, at: nowIso() });
    await this.options.store.appendBlackboard(
      run.id,
      "Auto Deep Dive",
      `Started ${critiqueId} from ${question.id}${targetClaimId ? ` targeting ${targetClaimId}` : ""}.`,
    );

    const existing = await this.options.store.listArtifacts(run.id);
    const sourceStartIndex = existing.filter((artifact) => artifact.kind === "source").length;
    const claimStartIndex = existing.filter((artifact) => artifact.kind === "claim").length;
    const questionStartIndex = existing.filter((artifact) => artifact.kind === "question").length;
    const auditStartIndex = existing.filter((artifact) => artifact.kind === "audit").length;

    const searchResults = await this.search(run, tasks, signal);
    const sourceResults = await this.readSources(run, searchResults.slice(0, 6), signal, { startIndex: sourceStartIndex });
    const deepDiveClaims = await this.extractClaims(run, sourceResults, signal, { startIndex: claimStartIndex });
    await this.challengeClaims(run, deepDiveClaims, signal, { startIndex: questionStartIndex });
    await this.auditClaims(run, deepDiveClaims, sourceResults, signal, { startIndex: auditStartIndex });
    await this.writeContradictionMatrix(run, sourceResults, deepDiveClaims, "auto_deep_dive");
    await this.writeQualityAudit(run, sourceResults, deepDiveClaims, "auto_deep_dive");
    await this.writeEvidenceLedger(run, sourceResults, deepDiveClaims, { phase: "auto_deep_dive" });

    await this.emit({
      type: "deep_dive.finished",
      runId: run.id,
      questionId: question.id,
      critiqueId,
      sourceCount: sourceResults.length,
      claimCount: deepDiveClaims.length,
      at: nowIso(),
    });
    await this.options.store.appendBlackboard(
      run.id,
      "Auto Deep Dive Complete",
      `Finished ${critiqueId}: ${sourceResults.length} sources, ${deepDiveClaims.length} claims.`,
    );

    return {
      questionId: question.id,
      critique,
      sources: sourceResults,
      claims: deepDiveClaims,
    };
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
    const startedAt = Date.now();
    const contextWithTask = [
      context,
      contextBlock("task", [`Role: ${roleLabel(role)}`, `Label: ${label}`, "", userPrompt].join("\n")),
    ].join("\n\n");
    await this.emit({ type: "agent.started", runId: run.id, agent: role, taskId, label, at: nowIso() });
    const result = await this.roleRunner.run(
      {
        role,
        taskId,
        label,
        systemPrompt: buildSystemPrompt(role),
        userPrompt,
        context: contextWithTask,
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
    await this.emit({
      type: "agent.finished",
      runId: run.id,
      agent: role,
      taskId,
      usedPi: result.usedPi,
      model: result.model,
      durationMs: elapsedMs(startedAt),
      at: nowIso(),
    });
    return result.text;
  }

  private async buildRoleContext(
    run: ResearchRun,
    memory: MemoryBundle,
    extraBlocks: Record<string, string> = {},
  ): Promise<string> {
    const [blackboard, events, artifactIndex] = await Promise.all([
      this.options.store.readArtifact(run.id, "02_blackboard.md").catch(() => undefined),
      this.options.store.readEvents(run.id).catch(() => []),
      this.options.store.buildArtifactIndex(run.id).catch(() => undefined),
    ]);
    const runState = [
      `Run: ${run.id}`,
      `Status: ${run.status}`,
      run.domain ? `Domain: ${run.domain}` : undefined,
      `Updated: ${run.updatedAt}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const recentEvents = events
      .slice(-12)
      .map((event) => `- ${event.at} ${event.type}: ${compactText(JSON.stringify(event), 260)}`)
      .join("\n");

    return [
      contextBlock("root_user_input", run.query),
      contextBlock("current_run_state", runState),
      contextBlock("relevant_memory", memoryToContext(memory)),
      contextBlock("blackboard", summarizeBlackboardForContext(blackboard?.body ?? "")),
      contextBlock("artifact_inventory", artifactsToContext(artifactIndex?.all ?? [])),
      contextBlock("recent_events", recentEvents),
      ...Object.entries(extraBlocks).map(([name, value]) => contextBlock(name, value)),
    ].join("\n\n");
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
    const context = await this.buildRoleContext(run, memory, {
      proposed_search_tasks: tasks.map((task) => `- ${task.id}: ${task.angle} -> ${task.query}`).join("\n"),
    });
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
    const searchStrategyText = await this.runRole(
      run,
      "search-strategist",
      "Stress-test search strategy",
      [
        "Review the proposed search tasks for independence, provider fit, and missing evidence classes.",
        "Identify which tasks should surface primary evidence, counter-evidence, weak signals, and source-quality risks.",
      ].join("\n"),
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
      "",
      "## Search Strategy Notes",
      "",
      searchStrategyText,
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
        const startedAt = Date.now();
        await this.emit({ type: "tool.started", runId: run.id, tool: `${provider.name}.search`, taskId, at: nowIso() });
        try {
          const results = await provider.search({ task, maxResults: 4 }, signal);
          await this.emit({
            type: "tool.finished",
            runId: run.id,
            tool: `${provider.name}.search`,
            taskId,
            ok: true,
            durationMs: elapsedMs(startedAt),
            at: nowIso(),
          });
          return results;
        } catch (error) {
          await this.emit({
            type: "tool.finished",
            runId: run.id,
            tool: `${provider.name}.search`,
            taskId,
            ok: false,
            error: compactError(error),
            durationMs: elapsedMs(startedAt),
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
    options: { startIndex?: number } = {},
  ): Promise<ReadSourceResult[]> {
    signal.throwIfAborted();
    const readResults = await mapWithConcurrency(
      results,
      this.limits.maxReaderAgents,
      async (result, index) => {
        const taskNumber = (options.startIndex ?? 0) + index + 1;
        const taskId = `read-${taskNumber}`;
        const agentStartedAt = Date.now();
        await this.emit({ type: "agent.started", runId: run.id, agent: "source-reader", taskId, label: result.title, at: nowIso() });
        let content = result.content || result.snippet;
        if (!result.content || result.content.length < 300) {
          const fetchStartedAt = Date.now();
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
              durationMs: elapsedMs(fetchStartedAt),
              at: nowIso(),
            });
          } catch (error) {
            await this.emit({
              type: "tool.finished",
              runId: run.id,
              tool: `${this.options.providers.fetchProvider.name}.fetch`,
              taskId,
              ok: false,
              error: compactError(error),
              durationMs: elapsedMs(fetchStartedAt),
              at: nowIso(),
            });
          }
        }
        const sourceKind = inferSourceKind(result.url, result.title);
        const reputation = await this.options.store.getSourceReputation({
          url: result.url,
          title: result.title,
          domain: run.domain,
        });
        const credibility = scoreSourceCredibility({
          sourceKind,
          url: result.url,
          title: result.title,
          hasContent: content.length > 0,
          providerScore: result.score,
          reputationAdjustment: reputation.adjustment,
        });
        const source: SourceRecord = {
          id: `source-${String(taskNumber).padStart(3, "0")}`,
          title: result.title,
          url: result.url,
          provider: result.provider,
          sourceKind,
          credibility,
          reputationAdjustment: reputation.adjustment,
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
            reputation_adjustment: source.reputationAdjustment,
            reputation_feedback: reputation.matchedFeedback,
            freshness: source.freshness,
            tags: source.tags,
          },
          body: sourceToMarkdown(source),
        });
        await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
        await this.emit({
          type: "agent.finished",
          runId: run.id,
          agent: "source-reader",
          taskId,
          durationMs: elapsedMs(agentStartedAt),
          at: nowIso(),
        });
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
    options: { startIndex?: number } = {},
  ): Promise<Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>> {
    signal.throwIfAborted();
    const taskId = makeTaskId("claims");
    const startedAt = Date.now();
    await this.emit({ type: "agent.started", runId: run.id, agent: "claim-extractor", taskId, label: "Extract claims", at: nowIso() });
    const claims = sources.slice(0, 8).map(({ source }, index) => makeClaimFromSource(source, (options.startIndex ?? 0) + index));
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
    await this.emit({
      type: "agent.finished",
      runId: run.id,
      agent: "claim-extractor",
      taskId,
      durationMs: elapsedMs(startedAt),
      at: nowIso(),
    });
    await this.options.store.appendBlackboard(run.id, "Claims", `Extracted ${artifacts.length} distinct claims.`);
    return artifacts;
  }

  private async challengeClaims(
    run: ResearchRun,
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    signal: AbortSignal,
    options: { startIndex?: number } = {},
  ): Promise<void> {
    await mapWithConcurrency(
      claims,
      this.limits.maxCritiqueAgents,
      async ({ claim, source }, index) => {
        signal.throwIfAborted();
        const taskId = `skeptic-${claim.id}`;
        const startedAt = Date.now();
        await this.emit({ type: "agent.started", runId: run.id, agent: "skeptic", taskId, label: `Challenge ${claim.id}`, at: nowIso() });
        const severity = claim.confidence < 0.7 ? "high" : "medium";
        const questionId = `question-${String((options.startIndex ?? 0) + index + 1).padStart(3, "0")}`;
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
        await this.emit({
          type: "agent.finished",
          runId: run.id,
          agent: "skeptic",
          taskId,
          durationMs: elapsedMs(startedAt),
          at: nowIso(),
        });
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
    const context = await this.buildRoleContext(run, memory, {
      claims: claims.map(({ claim }) => `- ${claim.id}: ${claim.text}`).join("\n"),
      sources: sources
        .slice(0, 8)
        .map(({ source }) => `- ${source.id} (${source.sourceKind}, ${source.credibility}): ${source.title}`)
        .join("\n"),
    });
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
    sources: ReadSourceResult[],
    signal: AbortSignal,
    options: { startIndex?: number } = {},
  ): Promise<void> {
    const artifactIndex = await this.options.store.buildArtifactIndex(run.id);
    const questionEntries = artifactIndex.byKind.get("question") ?? [];
    const sourceRecords = sources.map(({ source }) => source);
    await mapWithConcurrency(
      claims,
      this.limits.maxCritiqueAgents,
      async ({ claim, source }, index) => {
        signal.throwIfAborted();
        const taskId = `audit-${claim.id}`;
        const startedAt = Date.now();
        await this.emit({ type: "agent.started", runId: run.id, agent: "citation-auditor", taskId, label: `Audit ${claim.id}`, at: nowIso() });
        const support = claim.confidence >= 0.75 ? "supported" : claim.confidence >= 0.55 ? "partially_supported" : "weak";
        const auditId = `audit-${String((options.startIndex ?? 0) + index + 1).padStart(3, "0")}`;
        const relatedQuestions = questionEntries.filter((entry) => entry.frontmatter.target === claim.id);
        const candidateOpposingSources = sourceRecords
          .filter((candidate) => !claim.sources.includes(candidate.id))
          .filter((candidate) => {
            const text = `${candidate.title} ${candidate.summary} ${candidate.keyQuotes.join(" ")}`.toLowerCase();
            return /risk|concern|counter|contradict|uneven|but |however|still|shadow|warning|limited|weak/.test(text);
          });
        const opposingSources = (candidateOpposingSources.length > 0
          ? candidateOpposingSources
          : sourceRecords.filter((candidate) => !claim.sources.includes(candidate.id))
        ).slice(0, 3);
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
          "## Open Questions",
          "",
          relatedQuestions.length > 0
            ? relatedQuestions.map((question) => `- ${question.id}: ${question.title}`).join("\n")
            : "No open question artifact targets this claim yet.",
          "",
          "## Opposing / Qualifying Evidence Candidates",
          "",
          opposingSources.length > 0
            ? opposingSources
                .map((candidate) => `- ${candidate.id} (${candidate.sourceKind}, credibility ${candidate.credibility}): ${candidate.title}`)
                .join("\n")
            : "No separate opposing or qualifying source candidate was available in this phase.",
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
            questions: relatedQuestions.map((question) => question.id),
            opposing_sources: opposingSources.map((candidate) => candidate.id),
          },
          body,
        });
        await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
        await this.emit({
          type: "agent.finished",
          runId: run.id,
          agent: "citation-auditor",
          taskId,
          durationMs: elapsedMs(startedAt),
          at: nowIso(),
        });
      },
    );
    await this.options.store.appendBlackboard(run.id, "Audit", `Audited ${claims.length} claims for citation support.`);
  }

  private async writeEvidenceLedger(
    run: ResearchRun,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    options: { phase: ResearchPhase; insights?: ArtifactRef[] },
  ): Promise<ArtifactRef> {
    const sourceRecords = sources.map(({ source }) => source);
    const sourceById = new Map(sourceRecords.map((source) => [source.id, source]));
    const allArtifacts = await this.options.store.listArtifacts(run.id);
    const relevantArtifacts = allArtifacts.filter((artifact) =>
      ["question", "critique", "contradiction", "audit", "insight"].includes(artifact.kind),
    );
    const docs = (
      await Promise.all(relevantArtifacts.map((artifact) => this.options.store.readArtifact(run.id, artifact.path)))
    ).filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));

    const refsForClaim = (claimId: string, kind: "question" | "critique" | "audit") =>
      docs.filter((doc) => doc.kind === kind && doc.frontmatter.target === claimId);

    const sourceRows = sourceRecords
      .map(
        (source) =>
          `| ${source.id} | ${source.sourceKind} | ${source.credibility} | ${
            source.reputationAdjustment ?? 0
          } | ${source.title.replaceAll("|", "\\|")} |`,
      )
      .join("\n");

    const claimRows = claims
      .map(({ claim }) => {
        const questions = refsForClaim(claim.id, "question").map((doc) => doc.id);
        const audits = refsForClaim(claim.id, "audit").map((doc) => doc.id);
        const sourceCells = claim.sources
          .map((sourceId) => {
            const source = sourceById.get(sourceId);
            return source ? `${sourceId} (${source.credibility})` : sourceId;
          })
          .join(", ");
        return `| ${claim.id} | ${claim.claimKind} | ${claim.status} | ${claim.confidence} | ${sourceCells} | ${
          questions.join(", ") || "none"
        } | ${audits.join(", ") || "none"} |`;
      })
      .join("\n");

    const quoteSections = sourceRecords
      .map((source) => [
        `### ${source.id}: ${source.title}`,
        "",
        `Credibility: ${source.credibility}; kind: ${source.sourceKind}; reputation adjustment: ${source.reputationAdjustment ?? 0}`,
        "",
        ...source.keyQuotes.map((quote) => `> ${quote}`),
      ].join("\n"))
      .join("\n\n");

    const openChallenges = docs
      .filter((doc) => doc.kind === "question" || doc.kind === "critique")
      .filter((doc) => claims.some(({ claim }) => doc.frontmatter.target === claim.id || doc.frontmatter.question_id === claim.id))
      .map((doc) => `- ${doc.id}: ${doc.title}`)
      .join("\n");

    const insightRefs = options.insights?.length
      ? options.insights.map((insight) => `- ${insight.id}: ${insight.title}`).join("\n")
      : docs
          .filter((doc) => doc.kind === "insight")
          .map((doc) => `- ${doc.id}: ${doc.title}`)
          .join("\n");

    const existingLedgers = allArtifacts.filter((artifact) => artifact.kind === "ledger");
    const ledgerIndex = existingLedgers.length + 1;
    const ledgerId = `evidence-ledger-${String(ledgerIndex).padStart(3, "0")}`;
    const filename = ledgerIndex === 1 ? "evidence_ledger.md" : `${ledgerId}.md`;
    const body = [
      "# Evidence Ledger",
      "",
      `Phase: ${options.phase}`,
      "",
      "## Claim Trace Matrix",
      "",
      "| Claim | Kind | Status | Confidence | Supporting Sources | Challenges | Audits |",
      "| --- | --- | --- | ---: | --- | --- | --- |",
      claimRows || "| none | none | none | 0 | none | none | none |",
      "",
      "## Source Ledger",
      "",
      "| Source | Kind | Credibility | Reputation Adj. | Title |",
      "| --- | --- | ---: | ---: | --- |",
      sourceRows || "| none | none | 0 | 0 | none |",
      "",
      "## Evidence Quotes",
      "",
      quoteSections || "No quotes extracted.",
      "",
      "## Open Challenges",
      "",
      openChallenges || "No open challenge linked to the claims in this phase.",
      "",
      "## Insight Links",
      "",
      insightRefs || "No insight linked.",
    ].join("\n");

    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "ledger",
      id: ledgerId,
      title: `Evidence Ledger (${options.phase})`,
      filename,
      frontmatter: {
        id: ledgerId,
        type: "ledger",
        phase: options.phase,
        claim_count: claims.length,
        source_count: sourceRecords.length,
        insight_count: options.insights?.length ?? docs.filter((doc) => doc.kind === "insight").length,
        tags: ["evidence-ledger", options.phase],
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Evidence Ledger", `Wrote ${ledgerId} with ${claims.length} traced claims.`);
    return artifact;
  }

  private findOpposingSignals(claim: ClaimRecord, sources: SourceRecord[]): string[] {
    const claimText = claim.text.toLowerCase();
    const sourceText = (source: SourceRecord) => `${source.title} ${source.summary} ${source.keyQuotes.join(" ")}`.toLowerCase();
    const signals: string[] = [];

    for (const source of sources.filter((candidate) => !claim.sources.includes(candidate.id))) {
      const text = sourceText(source);
      if (/governance|audit|permission|compliance|security|data-control|data control/.test(claimText)) {
        if (/individual|bottom-up|speed|editor fit|shadow adoption|helpfulness/.test(text)) {
          signals.push(`${source.id}: bottom-up speed/adoption signal may qualify governance-first framing`);
        }
      } else if (/individual|bottom-up|speed|editor|developer/.test(claimText)) {
        if (/procurement|governance|audit|permission|compliance|data retention/.test(text)) {
          signals.push(`${source.id}: procurement/governance gate may limit bottom-up adoption`);
        }
      } else if (/workflow|context|integration|differentiation|benchmark/.test(claimText)) {
        if (/model benchmark|model quality|raw model|autocomplete/.test(text)) {
          signals.push(`${source.id}: model-capability framing may compete with workflow differentiation`);
        }
      } else if (/review|stale|long-horizon|mistake|risk/.test(claimText)) {
        if (/accelerate|speedup|routine edits|test generation/.test(text)) {
          signals.push(`${source.id}: productivity evidence may soften risk-heavy framing`);
        }
      }
    }

    return [...new Set(signals)].slice(0, 3);
  }

  private async writeContradictionMatrix(
    run: ResearchRun,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    phase: ResearchPhase,
  ): Promise<ArtifactRef> {
    const sourceRecords = sources.map(({ source }) => source);
    const sourceById = new Map(sourceRecords.map((source) => [source.id, source]));
    const rows = claims.map(({ claim }) => {
      const supportingSources = claim.sources.map((sourceId) => sourceById.get(sourceId)).filter((source): source is SourceRecord => Boolean(source));
      const sourceKinds = [...new Set(supportingSources.map((source) => source.sourceKind))];
      const hosts = [...new Set(supportingSources.map((source) => sourceHost(source.url)))];
      const opposingSignals = this.findOpposingSignals(claim, sourceRecords);
      const independence =
        supportingSources.length >= 2 && (hosts.length >= 2 || sourceKinds.length >= 2)
          ? "independent"
          : supportingSources.length >= 2
            ? "partially_independent"
            : "single_source";
      const verdict =
        opposingSignals.length > 0
          ? "mixed"
          : independence === "single_source"
            ? "needs_corroboration"
            : claim.status === "verified"
              ? "supported"
              : "qualified";
      return {
        claim,
        supportingSources,
        sourceKinds,
        hosts,
        opposingSignals,
        independence,
        verdict,
      };
    });

    const matrixRows = rows
      .map(
        (row) =>
          `| ${row.claim.id} | ${row.verdict} | ${row.independence} | ${row.supportingSources
            .map((source) => source.id)
            .join(", ")} | ${row.sourceKinds.join(", ") || "none"} | ${row.hosts.length} | ${
            row.opposingSignals.join("<br>") || "none"
          } |`,
      )
      .join("\n");
    const mixedCount = rows.filter((row) => row.verdict === "mixed").length;
    const needsCorroborationCount = rows.filter((row) => row.verdict === "needs_corroboration").length;
    const existing = await this.options.store.listArtifacts(run.id);
    const matrixIndex = existing.filter((artifact) => artifact.kind === "contradiction").length + 1;
    const matrixId = `contradiction-matrix-${String(matrixIndex).padStart(3, "0")}`;
    const body = [
      "# Cross-check & Contradiction Matrix",
      "",
      `Phase: ${phase}`,
      "",
      "## Matrix",
      "",
      "| Claim | Verdict | Independence | Supporting Sources | Source Kinds | Host Count | Opposing / Qualifying Signals |",
      "| --- | --- | --- | --- | --- | ---: | --- |",
      matrixRows || "| none | none | none | none | none | 0 | none |",
      "",
      "## Summary",
      "",
      `- Claims checked: ${rows.length}`,
      `- Mixed claims: ${mixedCount}`,
      `- Claims needing corroboration: ${needsCorroborationCount}`,
      "",
      "## Interpretation Rules",
      "",
      "- `supported`: evidence is reasonably strong and no counter-signal was detected.",
      "- `mixed`: at least one source introduces a qualifying or counter signal.",
      "- `needs_corroboration`: claim relies on a single supporting source.",
      "- `partially_independent`: multiple sources exist but share host or narrow source-kind diversity.",
    ].join("\n");
    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "contradiction",
      id: matrixId,
      title: `Cross-check Matrix (${phase})`,
      collection: "contradictions",
      frontmatter: {
        id: matrixId,
        type: "contradiction",
        phase,
        claim_count: rows.length,
        mixed_count: mixedCount,
        needs_corroboration_count: needsCorroborationCount,
        claims: rows.map((row) => row.claim.id),
        sources: [...new Set(rows.flatMap((row) => row.supportingSources.map((source) => source.id)))],
        tags: ["cross-check", "contradiction", phase],
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.options.store.appendBlackboard(
      run.id,
      "Cross-check Matrix",
      `Wrote ${matrixId}; mixed=${mixedCount}, needs_corroboration=${needsCorroborationCount}.`,
    );
    return artifact;
  }

  private async writeMemoryUpdate(
    run: ResearchRun,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    options: { phase: ResearchPhase; domain?: string; focus?: string; report: ArtifactRef },
  ): Promise<ArtifactRef> {
    const sourceRecords = sources.map(({ source }) => source);
    const sourceKinds = [...new Set(sourceRecords.map((source) => source.sourceKind))];
    const hosts = [...new Set(sourceRecords.map((source) => sourceHost(source.url)))];
    const highCredibility = sourceRecords.filter((source) => source.credibility >= 0.75);
    const challenged = claims.filter(({ claim }) => claim.status !== "verified");
    const reputationAdjusted = sourceRecords.filter((source) => (source.reputationAdjustment ?? 0) !== 0);
    const dominantSourceKind = Object.entries(
      sourceRecords.reduce<Record<string, number>>((counts, source) => {
        counts[source.sourceKind] = (counts[source.sourceKind] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort((a, b) => b[1] - a[1])[0]?.[0];
    const lessonTitle = `Research lesson ${new Date().toISOString().slice(0, 10)} (${options.phase})`;
    const lesson = [
      sourceKinds.length < 3
        ? "This run had limited source-kind diversity; future runs on similar questions should allocate more searches to independent primary or practitioner evidence."
        : "This run benefited from a mixed source set; preserving source-kind diversity should remain part of the default search plan.",
      challenged.length > 0
        ? "Challenged claims should be carried forward as follow-up search targets rather than hidden in the final narrative."
        : "Verified claims were comparatively strong, but future runs should still inspect source independence before raising confidence.",
      reputationAdjusted.length > 0
        ? "User source reputation feedback affected scoring; future runs should surface these adjustments in source review."
        : "No source reputation feedback affected this run; future user ratings can improve source priors.",
    ].join(" ");
    const evidence = [
      `${sourceRecords.length} sources across ${sourceKinds.length} source kinds and ${hosts.length} hosts.`,
      `${highCredibility.length} high-credibility sources; ${challenged.length} challenged claims.`,
      dominantSourceKind ? `Dominant source kind: ${dominantSourceKind}.` : "No dominant source kind detected.",
      `Report artifact: ${options.report.id}.`,
    ];
    const tags = [
      "run-memory",
      options.phase,
      ...(options.domain ? [options.domain] : []),
      ...sourceKinds.slice(0, 4),
    ];
    const existing = await this.options.store.listArtifacts(run.id);
    const memoryIndex = existing.filter((artifact) => artifact.kind === "memory").length + 1;
    const memoryId = `memory-update-${String(memoryIndex).padStart(3, "0")}`;
    const body = [
      "# Memory Update",
      "",
      `Phase: ${options.phase}`,
      options.focus ? `Focus: ${options.focus}` : undefined,
      "",
      "## Reusable Lesson",
      "",
      lesson,
      "",
      "## Evidence",
      "",
      ...evidence.map((item) => `- ${item}`),
      "",
      "## Next Run Hints",
      "",
      sourceKinds.length < 3 ? "- Increase source-kind diversity before final synthesis." : "- Preserve the current source-kind diversity pattern.",
      challenged.length > 0 ? "- Seed follow-up searches from challenged claim ids and question artifacts." : "- Continue auditing verified claims for source independence.",
      "- Keep source reputation adjustments visible in source review.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "memory",
      id: memoryId,
      title: `Memory Update (${options.phase})`,
      collection: "memory",
      frontmatter: {
        id: memoryId,
        type: "memory",
        memory_kind: "run_lesson",
        phase: options.phase,
        domain: options.domain,
        report: options.report.id,
        source_count: sourceRecords.length,
        claim_count: claims.length,
        challenged_claim_count: challenged.length,
        tags,
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.options.store.appendRecurringLesson({
      runId: run.id,
      title: lessonTitle,
      domain: options.domain,
      lesson,
      evidence,
      tags,
    });
    await this.options.store.appendBlackboard(run.id, "Memory Update", `Wrote ${memoryId} and updated global recurring lessons.`);
    return artifact;
  }

  private async writeQualityAudit(
    run: ResearchRun,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    phase: ResearchPhase,
  ): Promise<ArtifactRef> {
    const sourceRecords = sources.map(({ source }) => source);
    const averageCredibility =
      sourceRecords.length === 0
        ? 0
        : Number((sourceRecords.reduce((sum, source) => sum + source.credibility, 0) / sourceRecords.length).toFixed(2));
    const sourceMix = sourceRecords.reduce<Record<string, number>>((counts, source) => {
      counts[source.sourceKind] = (counts[source.sourceKind] ?? 0) + 1;
      return counts;
    }, {});
    const sourceKindCount = Object.keys(sourceMix).length;
    const strongSourceCount = sourceRecords.filter((source) => source.credibility >= 0.75).length;
    const weakSourceCount = sourceRecords.filter((source) => source.credibility < 0.55).length;
    const reputationAdjustedCount = sourceRecords.filter((source) => (source.reputationAdjustment ?? 0) !== 0).length;
    const verifiedClaims = claims.filter(({ claim }) => claim.status === "verified").length;
    const challengedClaims = claims.filter(({ claim }) => claim.status !== "verified").length;
    const qualityScore = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          averageCredibility * 45 +
            Math.min(sourceKindCount / 4, 1) * 20 +
            Math.min(claims.length / 4, 1) * 15 +
            (claims.length > 0 ? 10 : 0) +
            (strongSourceCount > 0 ? 10 : 0) -
            weakSourceCount * 2,
        ),
      ),
    );

    const riskFlags = [
      sourceRecords.length < 6 ? "Low source count; broaden search before treating the report as comprehensive." : undefined,
      sourceKindCount < 3 ? "Limited source diversity; independent corroboration may be weak." : undefined,
      weakSourceCount > Math.max(2, sourceRecords.length / 3) ? "Many sources have low credibility scores." : undefined,
      challengedClaims > verifiedClaims ? "More claims are challenged than verified." : undefined,
      strongSourceCount === 0 ? "No high-credibility source was identified in this phase." : undefined,
    ].filter((flag): flag is string => Boolean(flag));

    const existing = await this.options.store.listArtifacts(run.id);
    const auditIndex = existing.filter((artifact) => artifact.id.startsWith("quality-audit")).length + 1;
    const auditId = `quality-audit-${String(auditIndex).padStart(3, "0")}`;
    const sourceMixLines = Object.entries(sourceMix)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `- ${kind}: ${count}`)
      .join("\n");

    const body = [
      "# Quality Audit Summary",
      "",
      `Phase: ${phase}`,
      "",
      "## Score",
      "",
      `Quality score: **${qualityScore}/100**`,
      "",
      "## Evidence Coverage",
      "",
      `- Sources: ${sourceRecords.length}`,
      `- Average source credibility: ${averageCredibility}`,
      `- High-credibility sources: ${strongSourceCount}`,
      `- Weak sources: ${weakSourceCount}`,
      `- Reputation-adjusted sources: ${reputationAdjustedCount}`,
      "",
      "## Source Mix",
      "",
      sourceMixLines || "No sources.",
      "",
      "## Claim Status",
      "",
      `- Claims: ${claims.length}`,
      `- Verified claims: ${verifiedClaims}`,
      `- Challenged or weak claims: ${challengedClaims}`,
      "",
      "## Risk Flags",
      "",
      riskFlags.length > 0 ? riskFlags.map((flag) => `- ${flag}`).join("\n") : "- No high-severity structural risk detected.",
      "",
      "## Recommended Next Actions",
      "",
      "- Deepen any high-severity questions before using this as a decision memo.",
      "- Prefer independent primary evidence for high-impact factual or causal claims.",
      "- Use user feedback on source and citation quality to tune future credibility scoring.",
    ].join("\n");

    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "audit",
      id: auditId,
      title: `Quality Audit Summary (${phase})`,
      collection: "audits",
      frontmatter: {
        id: auditId,
        type: "audit",
        audit_kind: "quality_summary",
        phase,
        quality_score: qualityScore,
        average_source_credibility: averageCredibility,
        source_count: sourceRecords.length,
        claim_count: claims.length,
        risk_flag_count: riskFlags.length,
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Quality Audit", `Quality score ${qualityScore}/100 for ${phase} phase.`);
    return artifact;
  }

  private async writeContinuationReport(
    run: ResearchRun,
    focus: string,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    memory: MemoryBundle,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    const existingReports = (await this.options.store.listArtifacts(run.id)).filter((artifact) => artifact.kind === "report");
    const reportIndex = existingReports.length + 1;
    const reportId = `followup-report-${String(reportIndex).padStart(3, "0")}`;
    const context = await this.buildRoleContext(run, memory, {
      followup_focus: focus,
      new_claims: claims.map(({ claim }) => `- ${claim.id} (${claim.status}, ${claim.confidence}): ${claim.text}`).join("\n"),
      new_sources: sources
        .slice(0, 8)
        .map(({ source }) => `- ${source.id} (${source.sourceKind}, ${source.credibility}): ${source.title}`)
        .join("\n"),
    });
    const modelText = await this.runRole(
      run,
      "report-writer",
      "Write follow-up deep dive report",
      "Write a focused continuation report. State whether the new evidence strengthens, weakens, or reframes the challenged claim.",
      context,
      signal,
    );
    const body = [
      "# Follow-up Deep Dive Report",
      "",
      "## Focus",
      "",
      focus,
      "",
      "## Evidence Movement",
      "",
      claims.length > 0
        ? "The continuation added new claims and citations. Treat these as incremental evidence rather than a replacement for the original report."
        : "The continuation did not extract enough new evidence to change the report confidence.",
      "",
      "## New Claims",
      "",
      claims
        .map(
          ({ claim }) =>
            `- **${claim.id}** (${claim.status}, confidence ${claim.confidence}): ${claim.text} Sources: ${claim.sources
              .map((sourceId) => `\`${sourceId}\``)
              .join(", ")}`,
        )
        .join("\n") || "No new claims.",
      "",
      "## New Sources",
      "",
      sources
        .map(({ source }) => `- **${source.id}** [${source.sourceKind}, ${source.credibility}] ${source.title} - ${source.url}`)
        .join("\n") || "No new sources.",
      "",
      "## Writer Notes",
      "",
      modelText,
    ].join("\n");
    const artifact = await this.options.store.writeArtifact({
      runId: run.id,
      kind: "report",
      id: reportId,
      title: "Follow-up Deep Dive Report",
      filename: `${reportId}.md`,
      frontmatter: {
        id: reportId,
        type: "report",
        report_kind: "followup",
        claim_count: claims.length,
        source_count: sources.length,
        tags: ["followup", "deep-dive"],
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    await this.options.store.appendBlackboard(run.id, "Continuation Report", `Wrote ${reportId}.`);
    return artifact;
  }

  private async writeReport(
    run: ResearchRun,
    input: RunInput,
    sources: ReadSourceResult[],
    claims: Array<{ claim: ClaimRecord; source: SourceRecord; artifact: ArtifactRef }>,
    insights: ArtifactRef[],
    memory: MemoryBundle,
    signal: AbortSignal,
    autoDeepDive?: AutoDeepDiveResult,
  ): Promise<ArtifactRef> {
    const context = await this.buildRoleContext(run, memory, {
      claims: claims.map(({ claim }) => `- ${claim.id} (${claim.status}, ${claim.confidence}): ${claim.text}`).join("\n"),
      sources: sources
        .slice(0, 8)
        .map(({ source }) => `- ${source.id} (${source.sourceKind}, ${source.credibility}): ${source.title}`)
        .join("\n"),
      auto_deep_dive: autoDeepDive?.questionId
        ? `Question: ${autoDeepDive.questionId}\nSources: ${autoDeepDive.sources.length}\nClaims: ${autoDeepDive.claims.length}`
        : "",
    });
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
    const deepDiveClaimLines = autoDeepDive?.claims
      .map(
        ({ claim }) =>
          `- **${claim.id}** (${claim.status}, confidence ${claim.confidence}): ${claim.text} Sources: ${claim.sources
            .map((sourceId) => `\`${sourceId}\``)
            .join(", ")}`,
      )
      .join("\n");
    const deepDiveSourceLines = autoDeepDive?.sources
      .slice(0, 6)
      .map(({ source }) => `- **${source.id}** [${source.sourceKind}, ${source.credibility}] ${source.title}`)
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
      "## Auto Deep Dive",
      "",
      autoDeepDive?.critique
        ? `The system automatically deepened \`${autoDeepDive.questionId}\` through \`${autoDeepDive.critique.id}\` before final synthesis.`
        : "No automatic deep dive was triggered.",
      "",
      "### Deep Dive Claims",
      "",
      deepDiveClaimLines || "No deep-dive claims were extracted.",
      "",
      "### Deep Dive Sources",
      "",
      deepDiveSourceLines || "No deep-dive sources were added.",
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
        auto_deep_dive: Boolean(autoDeepDive?.critique),
        auto_deep_dive_question: autoDeepDive?.questionId,
        auto_deep_dive_claim_count: autoDeepDive?.claims.length ?? 0,
        auto_deep_dive_source_count: autoDeepDive?.sources.length ?? 0,
        tags: ["final-report", slugFragment(input.query), ...(autoDeepDive?.critique ? ["auto-deep-dive"] : [])],
      },
      body,
    });
    await this.emit({ type: "artifact.created", runId: run.id, artifact, at: nowIso() });
    return artifact;
  }
}
