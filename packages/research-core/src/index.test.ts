import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoleRunner } from "@fdr/agent-runtime";
import { MarkdownStore } from "@fdr/knowledge";
import { MockFetchProvider, MockSearchProvider, type SearchProvider } from "@fdr/providers";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchController } from "./index";

const tempDirs: string[] = [];

const roleRunner: RoleRunner = {
  async run(input) {
    return {
      text: `Deterministic ${input.role} output for ${input.label}.`,
      usedPi: false,
    };
  },
};

const requiredArtifactKinds = ["report", "ledger", "contradiction", "audit", "memory", "claim", "source", "question"] as const;

async function makeController() {
  const dir = await mkdtemp(path.join(tmpdir(), "fdr-research-"));
  tempDirs.push(dir);
  const store = new MarkdownStore({ dataDir: dir });
  const controller = new ResearchController({
    store,
    roleRunner,
    providers: {
      searchProviders: [new MockSearchProvider()],
      fetchProvider: new MockFetchProvider(),
    },
    limits: {
      maxSearchAgents: 3,
      maxReaderAgents: 4,
      maxCritiqueAgents: 2,
    },
  });
  return { controller, store, dir };
}

async function makeSlowController() {
  const dir = await mkdtemp(path.join(tmpdir(), "fdr-research-slow-"));
  tempDirs.push(dir);
  const store = new MarkdownStore({ dataDir: dir });
  const slowRoleRunner: RoleRunner = {
    async run(_input, signal) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
      return { text: "slow deterministic output", usedPi: false };
    },
  };
  const controller = new ResearchController({
    store,
    roleRunner: slowRoleRunner,
    providers: {
      searchProviders: [new MockSearchProvider()],
      fetchProvider: new MockFetchProvider(),
    },
  });
  return { controller, store };
}

async function makeFailingController() {
  const dir = await mkdtemp(path.join(tmpdir(), "fdr-research-failing-"));
  tempDirs.push(dir);
  const store = new MarkdownStore({ dataDir: dir });
  const failingRoleRunner: RoleRunner = {
    async run() {
      throw new Error("role runner exploded");
    },
  };
  const controller = new ResearchController({
    store,
    roleRunner: failingRoleRunner,
    providers: {
      searchProviders: [new MockSearchProvider()],
      fetchProvider: new MockFetchProvider(),
    },
  });
  return { controller, store };
}

async function makeNoEvidenceController() {
  const dir = await mkdtemp(path.join(tmpdir(), "fdr-research-no-evidence-"));
  tempDirs.push(dir);
  const store = new MarkdownStore({ dataDir: dir });
  const emptySearchProvider: SearchProvider = {
    name: "mock",
    async search() {
      return [];
    },
  };
  const controller = new ResearchController({
    store,
    roleRunner,
    providers: {
      searchProviders: [emptySearchProvider],
      fetchProvider: new MockFetchProvider(),
    },
  });
  return { controller, store };
}

async function waitForRun(store: MarkdownStore, runId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await store.readRun(runId);
    if (run?.status === "finished" || run?.status === "failed" || run?.status === "cancelled") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run did not finish: ${runId}`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchController mock pipeline", () => {
  it("rejects run-scoped reads and feedback for missing runs", async () => {
    const { controller } = await makeController();
    await expect(controller.getEvents("missing-run")).rejects.toThrow("Run not found: missing-run");
    await expect(controller.listArtifacts("missing-run")).rejects.toThrow("Run not found: missing-run");
    await expect(controller.readArtifactById("missing-run", "final-report")).rejects.toThrow("Run not found: missing-run");
    await expect(
      controller.addFeedback("missing-run", {
        artifactId: "final-report",
        rating: "up",
        dimension: "usefulness",
      }),
    ).rejects.toThrow("Run not found: missing-run");
  });

  it("isolates throwing event listeners from run execution", async () => {
    const { controller, store } = await makeController();
    let observedEvents = 0;
    controller.subscribe(() => {
      observedEvents += 1;
      throw new Error("listener failed");
    });

    const run = await controller.createRun({
      query: "Research listener isolation for live event streams",
      maxSearchTasks: 1,
    });
    const finished = await waitForRun(store, run.id);
    expect(finished?.status).toBe("finished");
    expect(observedEvents).toBeGreaterThan(0);
    expect((await store.readEvents(run.id)).some((event) => event.type === "run.finished")).toBe(true);
  });

  it("emits failed status updates when run execution fails", async () => {
    const { controller, store } = await makeFailingController();
    const run = await controller.createRun({
      query: "Research failure status event consistency",
      maxSearchTasks: 1,
    });
    const finished = await waitForRun(store, run.id);
    expect(finished?.status).toBe("failed");

    const events = await store.readEvents(run.id);
    expect(events.some((event) => event.type === "run.failed" && event.error === "role runner exploded")).toBe(true);
    expect(events.some((event) => event.type === "run.updated" && event.status === "failed")).toBe(true);
  });

  it("fails instead of writing an empty report when no usable sources are collected", async () => {
    const { controller, store } = await makeNoEvidenceController();
    const run = await controller.createRun({
      query: "Research no evidence failure handling",
      maxSearchTasks: 1,
    });
    const finished = await waitForRun(store, run.id);
    expect(finished?.status).toBe("failed");

    const events = await store.readEvents(run.id);
    expect(events.some((event) => event.type === "run.failed" && event.error.includes("No usable sources"))).toBe(true);
    expect((await store.listArtifacts(run.id)).some((artifact) => artifact.id === "final-report")).toBe(false);
  });

  it("generates the core auditable artifact set for a run", async () => {
    const { controller, store, dir } = await makeController();
    expect(controller.getLimits().maxSearchAgents).toBe(3);
    expect(controller.getLimits().maxReaderAgents).toBe(4);
    expect(controller.getLimits().maxCritiqueAgents).toBe(2);

    const run = await controller.createRun({
      query: "Research auditable multi-agent DeepResearch reliability",
      maxSearchTasks: 2,
    });

    const finished = await waitForRun(store, run.id);
    expect(finished?.status).toBe("finished");

    const artifacts = await store.listArtifacts(run.id);
    const kinds = new Set(artifacts.map((artifact) => artifact.kind));
    for (const kind of requiredArtifactKinds) {
      expect(kinds.has(kind)).toBe(true);
    }

    const events = await store.readEvents(run.id);
    expect(events.some((event) => event.type === "deep_dive.started")).toBe(true);
    expect(events.some((event) => event.type === "deep_dive.finished")).toBe(true);
    expect(
      events.some((event) => event.type === "tool.started" && event.taskId === "auto-deep-dive-001-search-1-mock"),
    ).toBe(true);
    expect(events.some((event) => event.type === "agent.finished" && event.agent === "planner" && event.usedPi === false)).toBe(
      true,
    );
    expect(events.some((event) => event.type === "agent.finished" && event.agent === "search-strategist")).toBe(true);
    expect(events.some((event) => event.type === "agent.finished" && typeof event.durationMs === "number")).toBe(true);
    expect(events.some((event) => event.type === "tool.finished" && typeof event.durationMs === "number")).toBe(true);

    const plan = artifacts.find((artifact) => artifact.id === "research-plan");
    expect(plan).toBeDefined();
    const planDoc = await store.readArtifact(run.id, plan!.path);
    expect(planDoc?.body).toContain("## Search Strategy Notes");

    const autoCritique = artifacts.find((artifact) => artifact.kind === "critique" && artifact.id.startsWith("auto-deep-dive"));
    expect(autoCritique).toBeDefined();
    const autoCritiqueDoc = await store.readArtifact(run.id, autoCritique!.path);
    expect(autoCritiqueDoc?.body).toContain("Auto Deep Dive Request");
    expect(autoCritiqueDoc?.frontmatter.critique_kind).toBe("auto_deep_dive");

    const firstAudit = artifacts.find((artifact) => artifact.kind === "audit" && artifact.id === "audit-001");
    expect(firstAudit).toBeDefined();
    const firstAuditDoc = await store.readArtifact(run.id, firstAudit!.path);
    expect(firstAuditDoc?.body).toContain("## Open Questions");
    expect(firstAuditDoc?.body).toContain("question-001");
    expect(firstAuditDoc?.body).toContain("## Opposing / Qualifying Evidence Candidates");
    expect(firstAuditDoc?.frontmatter.questions).toContain("question-001");
    expect(Array.isArray(firstAuditDoc?.frontmatter.opposing_sources) ? firstAuditDoc.frontmatter.opposing_sources.length : 0).toBeGreaterThan(0);

    const finalReport = artifacts.find((artifact) => artifact.id === "final-report");
    expect(finalReport).toBeDefined();
    const finalReportDoc = await store.readArtifact(run.id, finalReport!.path);
    expect(finalReportDoc?.body).toContain("## Auto Deep Dive");
    expect(finalReportDoc?.frontmatter.auto_deep_dive).toBe(true);

    const feedbackArtifact = await controller.addFeedback(run.id, {
      artifactId: "final-report",
      rating: "up",
      dimension: "report_value",
      note: "Answered the root question with traceable evidence.",
    });
    expect(feedbackArtifact.kind).toBe("feedback");
    const reportAfterFeedback = await store.readArtifact(run.id, finalReport!.path);
    expect(reportAfterFeedback?.frontmatter.feedback_count).toBe(1);
    expect(reportAfterFeedback?.body).toContain("## Human Feedback");
    expect(reportAfterFeedback?.body).toContain("Answered the root question with traceable evidence.");
    const userPreferences = await readFile(path.join(dir, "global", "user_preferences.md"), "utf8");
    expect(userPreferences).toContain("Answered the root question with traceable evidence.");
    expect(userPreferences).toContain("Artifact kind: report");
    const eventsAfterFeedback = await store.readEvents(run.id);
    expect(
      eventsAfterFeedback.some((event) => event.type === "artifact.updated" && event.artifact.id === "final-report"),
    ).toBe(true);
    await expect(
      controller.addFeedback(run.id, {
        artifactId: "missing-artifact",
        rating: "down",
        dimension: "usefulness",
      }),
    ).rejects.toThrow("Artifact not found: missing-artifact");
    expect((await store.listArtifacts(run.id)).filter((artifact) => artifact.kind === "feedback")).toHaveLength(1);

    const ledgers = artifacts.filter((artifact) => artifact.kind === "ledger");
    expect(ledgers.length).toBeGreaterThanOrEqual(2);
    const ledgerDocs = await Promise.all(ledgers.map((artifact) => store.readArtifact(run.id, artifact.path)));
    expect(ledgerDocs.some((doc) => doc?.frontmatter.phase === "auto_deep_dive")).toBe(true);

    const ledger = artifacts.find((artifact) => artifact.kind === "ledger");
    expect(ledger).toBeDefined();
    const ledgerDoc = await store.readArtifact(run.id, ledger!.path);
    expect(ledgerDoc?.body).toContain("Claim Trace Matrix");
    expect(ledgerDoc?.body).toContain("Evidence Quotes");

    const contradiction = artifacts.find((artifact) => artifact.kind === "contradiction");
    expect(contradiction).toBeDefined();
    const contradictionDoc = await store.readArtifact(run.id, contradiction!.path);
    expect(contradictionDoc?.body).toContain("Cross-check & Contradiction Matrix");
    expect(contradictionDoc?.body).toContain("Opposing / Qualifying Signals");
    const contradictions = artifacts.filter((artifact) => artifact.kind === "contradiction");
    const contradictionDocs = await Promise.all(contradictions.map((artifact) => store.readArtifact(run.id, artifact.path)));
    expect(contradictionDocs.some((doc) => doc?.frontmatter.phase === "auto_deep_dive")).toBe(true);

    const recurringLessons = await readFile(path.join(dir, "global", "recurring_lessons.md"), "utf8");
    expect(recurringLessons).toContain(run.id);
    expect(recurringLessons).toContain("Reusable research lessons");
  });

  it("continues from a generated question and appends follow-up artifacts", async () => {
    const { controller, store, dir } = await makeController();
    const domainDir = path.join(dir, "domains", "ai-coding-agents");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      path.join(domainDir, "map.md"),
      ["---", "id: domain-map", "type: memory", "title: Domain Map", "---", "", "# Domain Map", "", "Retain domain context in follow-up runs."].join(
        "\n",
      ),
    );
    const run = await controller.createRun({
      query: "Research follow-up questioning for DeepResearch agents",
      domain: "ai-coding-agents",
      maxSearchTasks: 2,
    });
    await waitForRun(store, run.id);
    const before = await store.listArtifacts(run.id);
    const question = before.find((artifact) => artifact.kind === "question");
    expect(question).toBeDefined();

    await controller.continueRun(run.id, {
      questionId: question!.id,
      maxSearchTasks: 2,
    });
    const finished = await waitForRun(store, run.id);
    expect(finished?.status).toBe("finished");

    const after = await store.listArtifacts(run.id);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((artifact) => artifact.id.startsWith("followup-report"))).toBe(true);
    expect(after.filter((artifact) => artifact.kind === "ledger").length).toBeGreaterThanOrEqual(2);
    expect(after.filter((artifact) => artifact.kind === "contradiction").length).toBeGreaterThanOrEqual(2);
    const continuationMemory = await Promise.all(
      after
        .filter((artifact) => artifact.kind === "memory")
        .map((artifact) => store.readArtifact(run.id, artifact.path)),
    );
    expect(continuationMemory.some((doc) => doc?.frontmatter.phase === "continuation" && doc.frontmatter.domain === "ai-coding-agents")).toBe(
      true,
    );
    const events = await store.readEvents(run.id);
    expect(events.some((event) => event.type === "tool.started" && event.taskId === "followup-001-search-1-mock")).toBe(true);

    await expect(controller.continueRun(run.id, { questionId: "missing-question" })).rejects.toThrow(
      "Question artifact not found: missing-question",
    );
    expect((await store.readRun(run.id))?.status).toBe("finished");
  });

  it("marks an active run as cancelled when the user cancels it", async () => {
    const { controller, store } = await makeSlowController();
    const run = await controller.createRun({
      query: "Research cancellation behavior for long running research",
      maxSearchTasks: 2,
    });

    await expect(controller.cancelRun("missing-run")).rejects.toThrow("Run not found: missing-run");
    await expect(controller.cancelRun(run.id)).resolves.toBe(true);
    const finished = await waitForRun(store, run.id);
    expect(finished?.status).toBe("cancelled");

    const events = await store.readEvents(run.id);
    expect(events.some((event) => event.type === "run.updated" && event.status === "cancelled")).toBe(true);
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
  });

  it("exposes domain memory and artifact lookup by id", async () => {
    const { controller, store, dir } = await makeController();
    const domainDir = path.join(dir, "domains", "ai-coding-agents");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      path.join(domainDir, "map.md"),
      [
        "---",
        "id: domain-map",
        "type: memory",
        "title: Domain Map",
        "---",
        "",
        "# Domain Map",
        "",
        "Prefer enterprise governance evidence for AI coding agent research.",
      ].join("\n"),
    );
    await writeFile(
      path.join(domainDir, "trusted_sources.md"),
      [
        "---",
        "id: trusted-sources",
        "type: trusted_sources",
        "title: Trusted Sources",
        "---",
        "",
        "# Trusted Sources",
        "",
        "- https://demo.firedeepresearch.local/official/enterprise-governance - official governance documentation",
      ].join("\n"),
    );

    const memory = await controller.getMemory("ai-coding-agents");
    expect(memory.domain.some((doc) => doc.id === "domain-map")).toBe(true);

    const run = await controller.createRun({
      query: "Research artifact lookup by id",
      domain: "ai-coding-agents",
      maxSearchTasks: 1,
    });
    await waitForRun(store, run.id);

    const report = await controller.readArtifactById(run.id, "final-report");
    expect(report?.kind).toBe("report");
    expect(report?.body).toContain("Final Report");

    const source = await controller.readArtifactById(run.id, "source-001");
    expect(source?.frontmatter.reputation_adjustment).toBe(0.08);

    await controller.addFeedback(run.id, {
      artifactId: "source-001",
      rating: "up",
      dimension: "credibility",
      note: "Trusted in this domain.",
    });
    const trustedSources = await readFile(path.join(domainDir, "trusted_sources.md"), "utf8");
    expect(trustedSources).toContain("source-001");
    expect(trustedSources).toContain("Trusted in this domain.");
  });

  it("passes shared run state, memory, blackboard, and event context into role turns", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fdr-research-context-"));
    tempDirs.push(dir);
    const store = new MarkdownStore({ dataDir: dir });
    const contexts: string[] = [];
    const capturingRunner: RoleRunner = {
      async run(input) {
        contexts.push(input.context);
        return {
          text: `Captured ${input.role} context.`,
          usedPi: false,
        };
      },
    };
    const domainDir = path.join(dir, "domains", "ai-coding-agents");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      path.join(domainDir, "map.md"),
      ["---", "id: domain-map", "type: memory", "title: Domain Map", "---", "", "# Domain Map", "", "Prefer primary enterprise evidence."].join(
        "\n",
      ),
    );
    const controller = new ResearchController({
      store,
      roleRunner: capturingRunner,
      providers: {
        searchProviders: [new MockSearchProvider()],
        fetchProvider: new MockFetchProvider(),
      },
      limits: {
        maxSearchAgents: 1,
        maxReaderAgents: 1,
        maxCritiqueAgents: 1,
      },
    });

    const run = await controller.createRun({
      query: "Research shared role context packages",
      domain: "ai-coding-agents",
      maxSearchTasks: 1,
    });
    await waitForRun(store, run.id);

    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts[0]).toContain("<root_user_input>");
    expect(contexts[0]).toContain("<current_run_state>");
    expect(contexts[0]).toContain("Domain: ai-coding-agents");
    expect(contexts[0]).toContain("<relevant_memory>");
    expect(contexts[0]).toContain("Prefer primary enterprise evidence.");
    expect(contexts[0]).toContain("<blackboard>");
    expect(contexts[0]).toContain("Run initialized.");
    expect(contexts[0]).toContain("<artifact_inventory>");
    expect(contexts[0]).toContain("<recent_events>");
    expect(contexts[0]).toContain("run.created");
    expect(contexts[0]).toContain("<task>");
    expect(contexts[0]).toContain("Role: Planner");
    expect(contexts[0]).toContain("Label: Plan research angles");

    const artifacts = await store.listArtifacts(run.id);
    const question = artifacts.find((artifact) => artifact.kind === "question");
    expect(question).toBeDefined();
    for (let index = 1; index <= 24; index += 1) {
      await store.appendBlackboard(
        run.id,
        `Historical Section ${String(index).padStart(2, "0")}`,
        `Historical details ${index}. ${"Repeated blackboard context. ".repeat(12)}`,
      );
    }

    const contextCountBeforeContinuation = contexts.length;
    await controller.continueRun(run.id, {
      questionId: question!.id,
      maxSearchTasks: 1,
    });
    await waitForRun(store, run.id);

    const continuationContext = contexts.slice(contextCountBeforeContinuation).find((context) => context.includes("<followup_focus>"));
    expect(continuationContext).toContain("## Earlier Blackboard Summary");
    expect(continuationContext).toContain("Older sections omitted from this role context");
    expect(continuationContext).toContain("## Recent Blackboard Sections");
    expect(continuationContext).toContain("Historical Section 24");
    expect(continuationContext).toContain("<artifact_inventory>");
    expect(continuationContext).toContain("question-001 [question]");
    expect(continuationContext).toContain("refs=claim-001");
    expect(continuationContext).toContain("<task>");
    expect(continuationContext).toContain("Role: Report Writer");
  });
});
