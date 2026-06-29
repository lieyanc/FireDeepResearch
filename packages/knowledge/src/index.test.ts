import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownStore } from "./index";

const tempDirs: string[] = [];

async function makeStore(): Promise<MarkdownStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "fdr-knowledge-"));
  tempDirs.push(dir);
  const store = new MarkdownStore({ dataDir: dir });
  await store.ensureBase();
  return store;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MarkdownStore source reputation", () => {
  it("preserves run domain metadata across status updates", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "domain memory test", domain: "ai-coding-agents" });

    expect(run.domain).toBe("ai-coding-agents");
    await store.updateRun({ ...run, status: "running" });

    const persisted = await store.readRun(run.id);
    expect(persisted?.domain).toBe("ai-coding-agents");
    expect(persisted?.status).toBe("running");
  });

  it("matches feedback by normalized URL and returns bounded credibility adjustments", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "source reputation test" });
    const sourceArtifact = await store.writeArtifact({
      runId: run.id,
      kind: "source",
      id: "source-001",
      title: "Official enterprise documentation emphasizes governance",
      collection: "sources",
      frontmatter: {
        id: "source-001",
        type: "source",
        url: "https://example.com/docs/governance?utm_source=test",
      },
      body: "# Official enterprise documentation emphasizes governance\n\nUseful source.",
    });

    await store.appendSourceReputationFeedback({
      runId: run.id,
      feedback: {
        artifactId: sourceArtifact.id,
        rating: "up",
        dimension: "credibility",
        note: "Useful primary source",
      },
      artifact: await store.readArtifact(run.id, sourceArtifact.path),
    });

    const signal = await store.getSourceReputation({
      title: "Official enterprise documentation emphasizes governance (rerun)",
      url: "https://example.com/docs/governance?angle=rerun",
    });

    expect(signal.up).toBe(1);
    expect(signal.down).toBe(0);
    expect(signal.matchedFeedback).toBe(1);
    expect(signal.adjustment).toBeGreaterThan(0);

    const content = await readFile(path.join(store.globalDir, "source_reputation.md"), "utf8");
    expect(content).toContain("type: source_reputation");
    expect(content).toContain("title: Source Reputation");
    expect(content).toMatch(/updated_at: '?\d{4}-\d{2}-\d{2}T/);
  });

  it("uses domain trusted source memory as a reputation signal", async () => {
    const store = await makeStore();
    const domainDir = path.join(store.domainsDir, "ai-coding-agents");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      path.join(domainDir, "trusted_sources.md"),
      [
        "---",
        "type: trusted_sources",
        "title: Trusted Sources",
        "---",
        "",
        "# Trusted Sources",
        "",
        "- https://demo.firedeepresearch.local/official/enterprise-governance - official enterprise governance docs",
      ].join("\n"),
    );

    const signal = await store.getSourceReputation({
      domain: "ai-coding-agents",
      title: "Official enterprise documentation emphasizes governance and audit controls",
      url: "https://demo.firedeepresearch.local/official/enterprise-governance?utm_source=rerun",
    });

    expect(signal.matchedFeedback).toBe(0);
    expect(signal.trustedMatches).toBe(1);
    expect(signal.adjustment).toBe(0.08);
  });

  it("appends upvoted source feedback into domain trusted source memory", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "domain trusted feedback test", domain: "ai-coding-agents" });
    const sourceArtifact = await store.writeArtifact({
      runId: run.id,
      kind: "source",
      id: "source-001",
      title: "Trusted Domain Source",
      collection: "sources",
      frontmatter: {
        url: "https://example.com/domain-source",
      },
      body: "# Trusted Domain Source\n\nDomain-specific source.",
    });
    const source = await store.readArtifact(run.id, sourceArtifact.path);
    expect(source).toBeDefined();

    await store.appendDomainTrustedSourceFeedback({
      runId: run.id,
      domain: run.domain,
      feedback: {
        artifactId: "source-001",
        rating: "up",
        dimension: "credibility",
        note: "Use this source again for this domain.",
      },
      artifact: source,
    });
    await store.appendDomainTrustedSourceFeedback({
      runId: run.id,
      domain: run.domain,
      feedback: {
        artifactId: "source-001",
        rating: "up",
        dimension: "credibility",
        note: "Repeated vote should not duplicate the trusted source.",
      },
      artifact: source,
    });

    const content = await readFile(path.join(store.domainsDir, "ai-coding-agents", "trusted_sources.md"), "utf8");
    expect(content).toContain("type: trusted_sources");
    expect(content).toContain("Trusted Domain Source");
    expect(content).toContain("https://example.com/domain-source");
    expect(content).toContain("Use this source again for this domain.");
    expect(content.match(/https:\/\/example\.com\/domain-source/g)).toHaveLength(1);
  });

  it("appends feedback snippets to the target artifact body", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "target feedback test" });
    const claimArtifact = await store.writeArtifact({
      runId: run.id,
      kind: "claim",
      id: "claim-001",
      title: "Claim under review",
      collection: "claims",
      body: "# Claim\n\nEvidence-backed claim.",
    });
    const feedback = {
      artifactId: claimArtifact.id,
      rating: "down" as const,
      dimension: "citation_support" as const,
      note: "Citation does not support the exact wording.",
    };

    const feedbackArtifact = await store.appendFeedback(run.id, feedback);
    const secondFeedbackArtifact = await store.appendFeedback(run.id, { ...feedback, note: "Second note." });
    const updated = await store.appendFeedbackToArtifact(run.id, feedback, feedbackArtifact);
    const target = await store.readArtifact(run.id, claimArtifact.path);

    expect(feedbackArtifact.id).toMatch(/^feedback-\d+-[a-f0-9]{8}$/);
    expect(secondFeedbackArtifact.id).not.toBe(feedbackArtifact.id);
    expect(updated?.id).toBe("claim-001");
    expect(target?.frontmatter.feedback_count).toBe(1);
    expect(target?.frontmatter.latest_feedback).toBe(feedbackArtifact.id);
    expect(target?.body).toContain("## Human Feedback");
    expect(target?.body).toContain("Citation does not support the exact wording.");
  });

  it("appends non-source feedback into reusable user preference memory", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "user feedback memory test" });
    const reportArtifact = await store.writeArtifact({
      runId: run.id,
      kind: "report",
      id: "final-report",
      title: "Final Report",
      filename: "final_report.md",
      body: "# Final Report\n\nUseful report.",
    });
    const artifact = await store.readArtifact(run.id, reportArtifact.path);
    expect(artifact).toBeDefined();

    await store.appendUserFeedbackMemory({
      runId: run.id,
      feedback: {
        artifactId: "final-report",
        rating: "up",
        dimension: "report_value",
        note: "Prefer concise uncertainty summaries.",
      },
      artifact: artifact!,
    });

    const content = await readFile(path.join(store.globalDir, "user_preferences.md"), "utf8");
    expect(content).toContain("type: user_preferences");
    expect(content).toContain("Artifact kind: report");
    expect(content).toContain("Prefer concise uncertainty summaries.");
    expect(content).toContain("Guidance: Prefer similar handling in future runs.");
  });

  it("builds a local artifact index from Markdown frontmatter", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "artifact index test" });
    await store.writeArtifact({
      runId: run.id,
      kind: "claim",
      id: "claim-001",
      title: "Indexed Claim",
      collection: "claims",
      frontmatter: {
        status: "challenged",
        tags: ["enterprise", "governance"],
        sources: ["source-001"],
      },
      body: "# Indexed Claim\n\nClaim body.",
    });
    await store.writeArtifact({
      runId: run.id,
      kind: "source",
      id: "source-001",
      title: "Indexed Source",
      collection: "sources",
      frontmatter: {
        url: "https://example.com/source",
        tags: ["enterprise"],
      },
      body: "# Indexed Source\n\nSource body.",
    });

    const index = await store.buildArtifactIndex(run.id);

    expect(index.byId.get("claim-001")?.path).toBe("claims/claim-001.md");
    expect(index.byKind.get("claim")?.map((artifact) => artifact.id)).toContain("claim-001");
    expect(index.byTag.get("enterprise")?.map((artifact) => artifact.id)).toEqual(expect.arrayContaining(["claim-001", "source-001"]));
    expect(index.byFrontmatterValue.get("status:challenged")?.[0]?.id).toBe("claim-001");
    expect(index.byFrontmatterValue.get("sources:source-001")?.[0]?.id).toBe("claim-001");
    await expect(store.readArtifactById(run.id, "claim-001")).resolves.toMatchObject({ title: "Indexed Claim" });
  });

  it("does not leave temporary files after artifact writes", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "atomic artifact write test" });
    await writeFile(
      path.join(store.runDir(run.id), "02_blackboard.md"),
      [
        "---",
        "id: blackboard",
        "type: blackboard",
        "title: Research Blackboard",
        "updated_at: 2000-01-01T00:00:00.000Z",
        "---",
        "# Research Blackboard",
      ].join("\n"),
    );
    const artifact = await store.writeArtifact({
      runId: run.id,
      kind: "report",
      id: "final-report",
      title: "Final Report",
      filename: "final_report.md",
      body: "# Final Report\n\nAtomic write.",
    });
    const feedback = {
      artifactId: artifact.id,
      rating: "up" as const,
      dimension: "report_value" as const,
      note: "Looks stable.",
    };
    const feedbackArtifact = await store.appendFeedback(run.id, feedback);
    await store.appendFeedbackToArtifact(run.id, feedback, feedbackArtifact);
    await store.appendBlackboard(run.id, "Atomic Blackboard", "Blackboard appends should be atomic.");
    const sourceArtifact = await store.writeArtifact({
      runId: run.id,
      kind: "source",
      id: "source-001",
      title: "Stable Source",
      collection: "sources",
      frontmatter: {
        url: "https://example.com/source",
      },
      body: "# Stable Source\n\nAtomic global write.",
    });
    await store.appendSourceReputationFeedback({
      runId: run.id,
      feedback: {
        artifactId: sourceArtifact.id,
        rating: "up",
        dimension: "credibility",
      },
      artifact: await store.readArtifact(run.id, sourceArtifact.path),
    });
    await store.appendRecurringLesson({
      runId: run.id,
      title: "Atomic global lesson",
      lesson: "Global memory should be written atomically.",
      evidence: [sourceArtifact.id],
      tags: ["atomic"],
    });

    const rootFiles = await readdir(store.runDir(run.id));
    const feedbackFiles = await readdir(path.join(store.runDir(run.id), "feedback"));
    const globalFiles = await readdir(store.globalDir);
    expect([...rootFiles, ...feedbackFiles].some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(globalFiles.some((file) => file.endsWith(".tmp"))).toBe(false);
    const blackboard = await readFile(path.join(store.runDir(run.id), "02_blackboard.md"), "utf8");
    expect(blackboard).toContain("## Atomic Blackboard");
    expect(blackboard).not.toContain("updated_at: 2000-01-01T00:00:00.000Z");
    await expect(store.readArtifact(run.id, artifact.path)).resolves.toMatchObject({ id: "final-report" });
  });

  it("skips malformed event journal lines while preserving valid history", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "event journal recovery test" });

    await store.appendEvent(run.id, { type: "run.created", runId: run.id, at: "2026-06-29T00:00:00.000Z" });
    await appendFile(
      path.join(store.runDir(run.id), "events.jsonl"),
      [
        "{malformed json",
        JSON.stringify({ type: "run.updated", runId: run.id, status: "impossible", at: "2026-06-29T00:00:01.000Z" }),
        JSON.stringify({ type: "run.updated", runId: run.id, status: "running", at: "2026-06-29T00:00:02.000Z" }),
        "",
      ].join("\n"),
    );

    const events = await store.readEvents(run.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.updated"]);
  });

  it("refreshes recurring lesson metadata on append", async () => {
    const store = await makeStore();
    const filePath = path.join(store.globalDir, "recurring_lessons.md");
    await writeFile(
      filePath,
      ["---", "type: recurring_lessons", "updated_at: 2000-01-01T00:00:00.000Z", "---", "", "# Recurring Lessons"].join("\n"),
    );

    await store.appendRecurringLesson({
      runId: "run-001",
      title: "Fresh lesson",
      lesson: "Update the memory timestamp when appending.",
      evidence: ["final-report"],
      tags: ["metadata"],
    });

    const content = await readFile(filePath, "utf8");
    expect(content).toContain("## Fresh lesson");
    expect(content).not.toContain("updated_at: 2000-01-01T00:00:00.000Z");
    expect(content).toMatch(/updated_at: '?\d{4}-\d{2}-\d{2}T/);
  });

  it("does not write non-source feedback into source reputation memory", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "report feedback reputation test" });
    const reportArtifact = await store.writeArtifact({
      runId: run.id,
      kind: "report",
      id: "final-report",
      title: "Final Report",
      filename: "final_report.md",
      body: "# Final Report\n\nUseful report.",
    });

    await store.appendSourceReputationFeedback({
      runId: run.id,
      feedback: {
        artifactId: reportArtifact.id,
        rating: "up",
        dimension: "report_value",
        note: "Helpful report.",
      },
      artifact: await store.readArtifact(run.id, reportArtifact.path),
    });

    const content = await readFile(path.join(store.globalDir, "source_reputation.md"), "utf8").catch(() => "");
    expect(content).not.toContain("final-report");
  });

  it("does not read artifacts outside the run directory", async () => {
    const store = await makeStore();
    const run = await store.createRun({ query: "path traversal test" });
    await writeFile(path.join(store.globalDir, "source_reputation.md"), "# Source Reputation\n\nPrivate global memory.");

    await expect(store.readArtifact(run.id, "../../global/source_reputation.md")).resolves.toBeUndefined();
    await expect(store.readArtifact(run.id, "00_user_input.md/../run.json")).resolves.toBeUndefined();
    await expect(store.readArtifact(run.id, "00_user_input.md")).resolves.toMatchObject({ id: "user-input" });
  });

  it("normalizes loose global and domain memory documents to memory artifacts", async () => {
    const store = await makeStore();
    await writeFile(
      path.join(store.globalDir, "research_playbook.md"),
      ["---", "type: research_playbook", "title: Research Playbook", "---", "", "# Research Playbook", "", "Use parallel search."].join("\n"),
    );
    const domainDir = path.join(store.domainsDir, "ai-coding-agents");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      path.join(domainDir, "map.md"),
      ["---", "type: domain_map", "title: Domain Map", "---", "", "# Domain Map", "", "Track enterprise governance evidence."].join("\n"),
    );

    const memory = await store.loadMemory("ai-coding-agents");
    expect(memory.global[0]?.kind).toBe("memory");
    expect(memory.domain[0]?.kind).toBe("memory");
  });
});
