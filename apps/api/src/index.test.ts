import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarkdownStore } from "@fdr/knowledge";
import { MockFetchProvider, MockSearchProvider } from "@fdr/providers";
import { ResearchController, type ResearchControllerOptions } from "@fdr/research-core";
import { afterEach, describe, expect, it } from "vitest";
import { createApiApp, readLlmRuntimeFromEnv, resolveCorsOrigin } from "./index";

const tempDirs: string[] = [];

const roleRunner: NonNullable<ResearchControllerOptions["roleRunner"]> = {
  async run(input) {
    return {
      text: `Deterministic ${input.role} output for ${input.label}.`,
      usedPi: false,
    };
  },
};

async function makeApi() {
  const dir = await mkdtemp(path.join(tmpdir(), "fdr-api-"));
  tempDirs.push(dir);
  const store = new MarkdownStore({ dataDir: dir });
  const providers = {
    searchProviders: [new MockSearchProvider()],
    fetchProvider: new MockFetchProvider(),
  };
  const research = new ResearchController({
    store,
    providers,
    roleRunner,
    limits: {
      maxSearchAgents: 2,
      maxReaderAgents: 3,
      maxCritiqueAgents: 2,
    },
  });
  return { app: createApiApp({ store, providers, research, llmRuntime: { mode: "fallback" } }), store, dir };
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

describe("FireDeepResearch API routes", () => {
  it("allows browser dev origins on dynamic localhost ports", async () => {
    const { app } = await makeApi();
    const preflight = await app.request("/api/health", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:18444",
        "access-control-request-method": "GET",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:18444");
    expect(resolveCorsOrigin("https://example.com")).toBeUndefined();
    expect(resolveCorsOrigin("https://example.com", { FDR_CORS_ORIGIN: "https://example.com" })).toBe("https://example.com");
  });

  it("serves health and domain memory without starting a server", async () => {
    const { app, dir } = await makeApi();
    const domainDir = path.join(dir, "domains", "ai-coding-agents");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      path.join(domainDir, "map.md"),
      ["---", "id: domain-map", "type: memory", "title: Domain Map", "---", "", "# Domain Map", "", "Use primary evidence."].join("\n"),
    );

    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      searchProviders: ["mock"],
      fetchProvider: "mock",
      llmRuntime: { mode: "fallback" },
    });

    const memory = await app.request("/api/memory?domain=ai-coding-agents");
    expect(memory.status).toBe(200);
    const payload = await memory.json();
    expect(payload.memory.domain.some((doc: { id: string }) => doc.id === "domain-map")).toBe(true);

    const unsafeMemoryDomain = await app.request("/api/memory?domain=../global");
    expect(unsafeMemoryDomain.status).toBe(400);
    await expect(unsafeMemoryDomain.json()).resolves.toMatchObject({
      error: expect.stringContaining("domain"),
    });
  });

  it("creates runs, reads artifacts by id, blocks escaped paths, and records feedback updates", async () => {
    const { app, store } = await makeApi();
    const created = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "API route integration research",
        domain: "api-tests",
        maxSearchTasks: 1,
      }),
    });
    expect(created.status).toBe(201);
    const { run } = await created.json();
    await waitForRun(store, run.id);

    const report = await app.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts/final-report`);
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      artifact: {
        id: "final-report",
        kind: "report",
      },
    });

    const invalidArtifactId = await app.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts/bad$id`);
    expect(invalidArtifactId.status).toBe(400);
    await expect(invalidArtifactId.json()).resolves.toMatchObject({
      error: expect.stringContaining("value"),
    });

    const escaped = await app.request(
      `/api/runs/${encodeURIComponent(run.id)}/artifacts/content?path=${encodeURIComponent("../../global/source_reputation.md")}`,
    );
    expect(escaped.status).toBe(404);

    const feedback = await app.request(`/api/runs/${encodeURIComponent(run.id)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifactId: "final-report",
        rating: "up",
        dimension: "report_value",
        note: "API route feedback note",
      }),
    });
    expect(feedback.status).toBe(201);

    const updatedReport = await app.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts/final-report`);
    const updatedPayload = await updatedReport.json();
    expect(updatedPayload.artifact.frontmatter.feedback_count).toBe(1);
    expect(updatedPayload.artifact.body).toContain("API route feedback note");

    const memoryAfterFeedback = await app.request("/api/memory");
    const memoryPayload = await memoryAfterFeedback.json();
    expect(memoryPayload.memory.global.some((doc: { id: string; body: string }) => doc.id === "user_preferences" && doc.body.includes("API route feedback note"))).toBe(
      true,
    );

    const missingFeedbackTarget = await app.request(`/api/runs/${encodeURIComponent(run.id)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifactId: "missing-artifact",
        rating: "down",
        dimension: "usefulness",
      }),
    });
    expect(missingFeedbackTarget.status).toBe(404);
    await expect(missingFeedbackTarget.json()).resolves.toMatchObject({
      error: "Artifact not found: missing-artifact",
    });

    const history = await app.request(`/api/runs/${encodeURIComponent(run.id)}/events/history`);
    const historyPayload = await history.json();
    expect(historyPayload.events.some((event: { type: string }) => event.type === "artifact.updated")).toBe(true);

    const missingQuestion = await app.request(`/api/runs/${encodeURIComponent(run.id)}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "missing-question" }),
    });
    expect(missingQuestion.status).toBe(404);
    await expect(missingQuestion.json()).resolves.toMatchObject({
      error: "Question artifact not found: missing-question",
    });

    const runAfterRejectedContinue = await store.readRun(run.id);
    expect(runAfterRejectedContinue?.status).toBe("finished");

    const missingCancel = await app.request("/api/runs/missing-run/cancel", { method: "POST" });
    expect(missingCancel.status).toBe(404);
    await expect(missingCancel.json()).resolves.toMatchObject({ error: "Run not found: missing-run" });

    const missingRunArtifacts = await app.request("/api/runs/missing-run/artifacts");
    expect(missingRunArtifacts.status).toBe(404);
    await expect(missingRunArtifacts.json()).resolves.toMatchObject({ error: "Run not found: missing-run" });

    const missingRunHistory = await app.request("/api/runs/missing-run/events/history");
    expect(missingRunHistory.status).toBe(404);
    await expect(missingRunHistory.json()).resolves.toMatchObject({ error: "Run not found: missing-run" });

    const missingRunEvents = await app.request("/api/runs/missing-run/events");
    expect(missingRunEvents.status).toBe(404);
    await expect(missingRunEvents.json()).resolves.toMatchObject({ error: "Run not found: missing-run" });
  });

  it("rejects unsafe or oversized user input before it reaches Markdown memory", async () => {
    const { app } = await makeApi();

    const unsafeDomain = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "Input validation research",
        domain: "../global",
      }),
    });
    expect(unsafeDomain.status).toBe(400);
    await expect(unsafeDomain.json()).resolves.toMatchObject({
      error: expect.stringContaining("domain"),
    });

    const created = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "Input validation accepted research",
        domain: " api-tests ",
        maxSearchTasks: 1,
      }),
    });
    expect(created.status).toBe(201);
    const { run } = await created.json();
    expect(run.domain).toBe("api-tests");

    const unsafeContinuationQuestion = await app.request(`/api/runs/${encodeURIComponent(run.id)}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questionId: "bad$id",
      }),
    });
    expect(unsafeContinuationQuestion.status).toBe(400);
    await expect(unsafeContinuationQuestion.json()).resolves.toMatchObject({
      error: expect.stringContaining("questionId"),
    });

    const longContinuationPrompt = await app.request(`/api/runs/${encodeURIComponent(run.id)}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "x".repeat(4_001),
      }),
    });
    expect(longContinuationPrompt.status).toBe(400);
    await expect(longContinuationPrompt.json()).resolves.toMatchObject({
      error: expect.stringContaining("prompt"),
    });

    const longFeedback = await app.request(`/api/runs/${encodeURIComponent(run.id)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifactId: "final-report",
        rating: "up",
        dimension: "report_value",
        note: "x".repeat(2_001),
      }),
    });
    expect(longFeedback.status).toBe(400);
    await expect(longFeedback.json()).resolves.toMatchObject({
      error: expect.stringContaining("note"),
    });
  });
});

describe("readLlmRuntimeFromEnv", () => {
  it("reports deterministic fallback when no complete Pi model is configured", () => {
    expect(readLlmRuntimeFromEnv({})).toEqual({ mode: "fallback" });
    expect(readLlmRuntimeFromEnv({ FDR_LLM_MODEL: "gpt-4.1" })).toEqual({ mode: "fallback" });
  });

  it("reports configured Pi provider and model without exposing credentials", () => {
    expect(
      readLlmRuntimeFromEnv({
        FDR_LLM_MODEL: "openai/gpt-4.1",
        OPENAI_API_KEY: "secret",
      }),
    ).toEqual({ mode: "pi", provider: "openai", model: "gpt-4.1" });

    expect(
      readLlmRuntimeFromEnv({
        FDR_LLM_PROVIDER: "openrouter",
        FDR_LLM_MODEL: "anthropic/claude-sonnet-4",
      }),
    ).toEqual({ mode: "pi", provider: "openrouter", model: "anthropic/claude-sonnet-4" });

    expect(
      readLlmRuntimeFromEnv({
        FDR_LLM_PROVIDER: "openrouter",
        FDR_LLM_MODEL: "gpt-4.1",
      }),
    ).toEqual({ mode: "pi", provider: "openrouter", model: "gpt-4.1" });
  });
});
