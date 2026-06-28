import { mkdtemp, rm } from "node:fs/promises";
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
  });
});

