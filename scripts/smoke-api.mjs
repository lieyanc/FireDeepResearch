#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const port = Number(process.env.FDR_API_SMOKE_PORT ?? 18_780 + Math.floor(Math.random() * 1_000));
const baseUrl = `http://127.0.0.1:${port}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  return { response, body };
}

async function waitForHealth() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const { response, body } = await request("/api/health");
      if (response.ok && body?.ok) {
        return body;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("API did not become healthy");
}

async function waitForRun(runId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}`);
    assert(response.ok, `run read failed: ${response.status}`);
    if (["finished", "failed", "cancelled"].includes(body.run.status)) {
      return body.run;
    }
    await sleep(100);
  }
  throw new Error(`Run did not finish: ${runId}`);
}

async function readArtifactById(runId, artifactId) {
  const payload = await request(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
  assert(payload.response.ok, `${artifactId} lookup failed: ${payload.response.status}`);
  return payload.body.artifact;
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fdr-api-smoke-"));
  const logPath = path.join(dataDir, "api.log");
  const child = spawn("pnpm", ["--filter", "@fdr/api", "start"], {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      FDR_API_PORT: String(port),
      FDR_DATA_DIR: dataDir,
      FDR_USE_MOCK_PROVIDERS: "true",
      FDR_MAX_SEARCH_AGENTS: "2",
      FDR_MAX_READER_AGENTS: "3",
      FDR_MAX_CRITIQUE_AGENTS: "2",
      FDR_LLM_PROVIDER: "",
      FDR_LLM_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });

  try {
    const health = await waitForHealth();
    assert(health.dataDir === dataDir, `API dataDir mismatch: ${health.dataDir}`);
    assert(health.searchProviders.includes("mock"), "API did not use mock search provider");
    assert(health.fetchProvider === "mock", "API did not use mock fetch provider");
    assert(health.llmRuntime?.mode === "fallback", "API did not use fallback LLM runtime");

    const unsafeMemory = await request("/api/memory?domain=../global");
    assert(unsafeMemory.response.status === 400, "unsafe memory domain was not rejected");

    const created = await request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        query: "Smoke test auditable DeepResearch pipeline",
        domain: " smoke-domain ",
        maxSearchTasks: 1,
      }),
    });
    assert(created.response.status === 201, `run create failed: ${created.response.status}`);
    const runId = created.body.run.id;
    assert(created.body.run.domain === "smoke-domain", "domain was not trimmed on create");

    const finished = await waitForRun(runId);
    assert(finished.status === "finished", `run did not finish successfully: ${finished.status}`);

    const artifacts = await request(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
    assert(artifacts.response.ok, "artifact list failed");
    const artifactKinds = new Set(artifacts.body.artifacts.map((artifact) => artifact.kind));
    for (const kind of ["report", "source", "claim", "question", "audit", "ledger", "contradiction", "memory"]) {
      assert(artifactKinds.has(kind), `missing artifact kind: ${kind}`);
    }

    const report = await readArtifactById(runId, "final-report");
    assert(report.kind === "report", "final-report is not a report artifact");
    assert(report.frontmatter.auto_deep_dive === true, "final report did not record auto deep dive metadata");
    assert(report.body.includes("## Key Claims"), "final report missing key claims section");
    assert(report.body.includes("## Auto Deep Dive"), "final report missing auto deep dive section");
    assert(report.body.includes("claim-001") && report.body.includes("source-001"), "final report did not link claims and sources");

    const autoDeepDive = await readArtifactById(runId, "auto-deep-dive-001");
    assert(autoDeepDive.kind === "critique", "auto deep dive request is not a critique artifact");
    assert(autoDeepDive.body.includes("## Trigger Question"), "auto deep dive request missing trigger question");
    assert(autoDeepDive.body.includes("auto-deep-dive-001-search-1"), "auto deep dive request missing search task trace");

    const evidenceLedger = await readArtifactById(runId, "evidence-ledger-001");
    assert(evidenceLedger.kind === "ledger", "evidence-ledger-001 is not a ledger artifact");
    assert(evidenceLedger.body.includes("## Claim Trace Matrix"), "evidence ledger missing claim trace matrix");
    assert(evidenceLedger.body.includes("claim-003") && evidenceLedger.body.includes("source-005"), "evidence ledger missing deep-dive claim/source trace");
    assert(evidenceLedger.body.includes("## Evidence Quotes"), "evidence ledger missing evidence quotes");

    const contradictionMatrix = await readArtifactById(runId, "contradiction-matrix-001");
    assert(contradictionMatrix.kind === "contradiction", "contradiction-matrix-001 is not a contradiction artifact");
    assert(contradictionMatrix.body.includes("## Matrix"), "contradiction matrix missing matrix section");
    assert(contradictionMatrix.body.includes("mixed") && contradictionMatrix.body.includes("needs_corroboration"), "contradiction matrix missing verdicts");

    const qualityAudit = await readArtifactById(runId, "quality-audit-001");
    assert(qualityAudit.kind === "audit", "quality-audit-001 is not an audit artifact");
    assert(qualityAudit.frontmatter.audit_kind === "quality_summary", "quality audit missing quality_summary frontmatter");
    assert(qualityAudit.body.includes("## Recommended Next Actions"), "quality audit missing next actions");

    const invalidArtifact = await request(`/api/runs/${encodeURIComponent(runId)}/artifacts/bad$id`);
    assert(invalidArtifact.response.status === 400, "invalid artifact id was not rejected");

    const escaped = await request(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/content?path=${encodeURIComponent("../../global/source_reputation.md")}`,
    );
    assert(escaped.response.status === 404, "escaped artifact path was not blocked");

    const feedback = await request(`/api/runs/${encodeURIComponent(runId)}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        artifactId: "final-report",
        rating: "up",
        dimension: "report_value",
        note: "API smoke feedback note",
      }),
    });
    assert(feedback.response.status === 201, `feedback failed: ${feedback.response.status}`);

    const updatedReport = await request(`/api/runs/${encodeURIComponent(runId)}/artifacts/final-report`);
    assert(updatedReport.body.artifact.frontmatter.feedback_count === 1, "feedback count was not written to report");
    assert(updatedReport.body.artifact.body.includes("API smoke feedback note"), "feedback note was not appended to report");

    const sourceFeedback = await request(`/api/runs/${encodeURIComponent(runId)}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        artifactId: "source-001",
        rating: "up",
        dimension: "credibility",
        note: "API smoke trusted source note",
      }),
    });
    assert(sourceFeedback.response.status === 201, `source feedback failed: ${sourceFeedback.response.status}`);

    const memory = await request("/api/memory");
    assert(
      memory.body.memory.global.some((doc) => doc.id === "user_preferences" && doc.body.includes("API smoke feedback note")),
      "non-source feedback was not written to user preferences",
    );

    const domainMemory = await request("/api/memory?domain=smoke-domain");
    assert(domainMemory.response.ok, "domain memory read failed");
    assert(
      domainMemory.body.memory.global.some((doc) => doc.id === "source_reputation" && doc.body.includes("API smoke trusted source note")),
      "source feedback was not written to global source reputation",
    );
    assert(
      domainMemory.body.memory.domain.some((doc) => doc.id === "trusted_sources" && doc.body.includes("API smoke trusted source note")),
      "upvoted source feedback was not written to domain trusted sources",
    );

    const updatedSource = await readArtifactById(runId, "source-001");
    assert(updatedSource.frontmatter.feedback_count === 1, "feedback count was not written to source");
    assert(updatedSource.body.includes("API smoke trusted source note"), "source feedback note was not appended to source");

    const missingQuestion = await request(`/api/runs/${encodeURIComponent(runId)}/continue`, {
      method: "POST",
      body: JSON.stringify({ questionId: "missing-question" }),
    });
    assert(missingQuestion.response.status === 404, "missing continuation question was not rejected");

    const continuation = await request(`/api/runs/${encodeURIComponent(runId)}/continue`, {
      method: "POST",
      body: JSON.stringify({ questionId: "question-001", maxSearchTasks: 1 }),
    });
    assert(continuation.response.status === 202, `continuation failed to start: ${continuation.response.status}`);
    const continued = await waitForRun(runId);
    assert(continued.status === "finished", `continuation did not finish successfully: ${continued.status}`);

    const artifactsAfterContinuation = await request(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
    assert(artifactsAfterContinuation.response.ok, "post-continuation artifact list failed");
    const followupReportRef = artifactsAfterContinuation.body.artifacts.find(
      (artifact) => artifact.kind === "report" && artifact.id.startsWith("followup-report"),
    );
    assert(followupReportRef, "continuation did not create a follow-up report");
    const followupReport = await readArtifactById(runId, followupReportRef.id);
    assert(followupReport.frontmatter.report_kind === "followup", "follow-up report missing report_kind frontmatter");
    assert(followupReport.body.includes("Follow-up Deep Dive Report"), "follow-up report missing title");
    assert(followupReport.body.includes("claim 001"), "follow-up report missing question focus");
    assert(followupReport.body.includes("incremental evidence"), "follow-up report missing evidence movement framing");

    const deepDiveRef = artifactsAfterContinuation.body.artifacts.find(
      (artifact) => artifact.kind === "critique" && artifact.id.startsWith("deep-dive-"),
    );
    assert(deepDiveRef, "continuation did not create a deep-dive request");
    const deepDive = await readArtifactById(runId, deepDiveRef.id);
    assert(deepDive.body.includes("Follow-up Deep Dive Request"), "deep-dive request missing title");
    assert(deepDive.body.includes("followup-001-search-1"), "deep-dive request missing search trace");

    const continuationMemoryRef = artifactsAfterContinuation.body.artifacts.find(
      (artifact) => artifact.kind === "memory" && artifact.id === "memory-update-002",
    );
    assert(continuationMemoryRef, "continuation did not create a memory update");
    const continuationMemory = await readArtifactById(runId, continuationMemoryRef.id);
    assert(continuationMemory.frontmatter.phase === "continuation", "continuation memory update missing phase metadata");
    assert(continuationMemory.frontmatter.domain === "smoke-domain", "continuation did not inherit run domain");

    const history = await request(`/api/runs/${encodeURIComponent(runId)}/events/history`);
    assert(history.response.ok, "event history failed");
    const eventTypes = new Set(history.body.events.map((event) => event.type));
    for (const type of [
      "run.created",
      "run.updated",
      "agent.started",
      "agent.finished",
      "tool.started",
      "tool.finished",
      "artifact.created",
      "artifact.updated",
      "claim.challenged",
      "insight.created",
      "deep_dive.started",
      "deep_dive.finished",
      "continuation.started",
      "continuation.finished",
      "run.finished",
    ]) {
      assert(eventTypes.has(type), `missing event type: ${type}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          runId,
          dataDir,
          initialArtifactCount: artifacts.body.artifacts.length,
          finalArtifactCount: artifactsAfterContinuation.body.artifacts.length,
          eventCount: history.body.events.length,
          followupReportId: followupReportRef.id,
          deepDiveId: deepDiveRef.id,
          continuationMemoryId: continuationMemoryRef.id,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(logPath, log);
    console.error(`API smoke failed. API log written to ${logPath}`);
    throw error;
  } finally {
    await terminateChild(child);
    if (!process.env.FDR_API_SMOKE_KEEP_DATA) {
      await rm(dataDir, { recursive: true, force: true });
    } else {
      await writeFile(logPath, log);
      console.log(`Kept smoke data at ${dataDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
