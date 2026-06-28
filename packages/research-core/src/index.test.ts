import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoleRunner } from "@fdr/agent-runtime";
import { MarkdownStore } from "@fdr/knowledge";
import { MockFetchProvider, MockSearchProvider } from "@fdr/providers";
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

async function waitForRun(store: MarkdownStore, runId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await store.readRun(runId);
    if (run?.status === "finished" || run?.status === "failed") {
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

    const recurringLessons = await readFile(path.join(dir, "global", "recurring_lessons.md"), "utf8");
    expect(recurringLessons).toContain(run.id);
    expect(recurringLessons).toContain("Reusable research lessons");
  });

  it("continues from a generated question and appends follow-up artifacts", async () => {
    const { controller, store } = await makeController();
    const run = await controller.createRun({
      query: "Research follow-up questioning for DeepResearch agents",
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
  });
});
