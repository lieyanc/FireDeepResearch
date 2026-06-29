#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_URL = process.env.FDR_UI_SMOKE_URL ?? "http://localhost:5173/";
const API_URL = process.env.FDR_UI_SMOKE_API_URL;
const INTERACT_FEEDBACK = process.env.FDR_UI_SMOKE_INTERACT_FEEDBACK === "true";
const OUT_DIR = process.env.FDR_UI_SMOKE_OUT_DIR ?? "/tmp/fdr-ui-smoke";
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
].filter(Boolean);

const viewports = [
  { name: "desktop", width: 1440, height: 1000, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && (await commandExists(candidate))) {
      return candidate;
    }
  }
  throw new Error("No Chrome/Chromium executable found. Set CHROME_BIN to run UI smoke.");
}

async function getJson(url, attempts = 80) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`Could not fetch ${url}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function seedRunForFeedback(apiUrl) {
  const created = await postJson(`${apiUrl}/api/runs`, {
    query: "UI smoke feedback interaction against generated artifacts",
    domain: "ui-smoke",
    maxSearchTasks: 1,
  });
  const runId = created.run.id;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const payload = await getJson(`${apiUrl}/api/runs/${encodeURIComponent(runId)}`, 1);
    if (["finished", "failed", "cancelled"].includes(payload.run.status)) {
      assert(payload.run.status === "finished", `Seed run ended with ${payload.run.status}`);
      return payload.run;
    }
    await sleep(100);
  }
  throw new Error(`Seed run did not finish: ${runId}`);
}

async function withCdp(chromeBin, viewport, options = {}) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), `fdr-ui-smoke-${viewport.name}-`));
  const port = 9_400 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((item) => item.type === "page") ?? targets[0];
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("Chrome did not expose a page debugging target.");
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    let messageId = 0;
    const pending = new Map();
    const events = [];

    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(message.data.toString());
      if (payload.id && pending.has(payload.id)) {
        pending.get(payload.id)(payload);
        pending.delete(payload.id);
      } else if (payload.method) {
        events.push(payload);
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve) => {
        messageId += 1;
        pending.set(messageId, resolve);
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });

    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text ?? "Runtime evaluation failed");
      }
      return response.result.result.value;
    };

    const waitForEvaluation = async (expression, label, attempts = 100) => {
      let lastValue;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        lastValue = await evaluate(expression);
        if (lastValue) {
          return lastValue;
        }
        await sleep(100);
      }
      throw new Error(`${viewport.name}: timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });
    await send("Page.navigate", { url: APP_URL });
    await sleep(4_500);

    let feedbackNote;
    let visibleFeedbackNote;
    if (options.interactFeedback) {
      await waitForEvaluation(
        `document.querySelector('[data-testid="stream-status"]')?.textContent?.includes("Stream live")`,
        "live stream status",
      );
      feedbackNote = `Browser smoke feedback ${viewport.name} ${Date.now()}`;
      visibleFeedbackNote = feedbackNote;
      await waitForEvaluation(
        `Boolean(document.querySelector('[data-testid="feedback-note"]') && document.querySelector('[data-testid="feedback-up"]:not(:disabled)'))`,
        "feedback controls",
      );
      const interaction = await evaluate(`(() => {
        const note = ${JSON.stringify(feedbackNote)};
        const input = document.querySelector('[data-testid="feedback-note"]');
        const select = document.querySelector('[data-testid="feedback-dimension"]');
        const button = document.querySelector('[data-testid="feedback-up"]');
        if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement) || !(button instanceof HTMLButtonElement)) {
          return { ok: false, reason: "feedback controls missing" };
        }
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        inputSetter?.call(input, note);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        selectSetter?.call(select, "report_value");
        select.dispatchEvent(new Event("change", { bubbles: true }));
        button.click();
        return { ok: true };
      })()`);
      assert(interaction.ok, `${viewport.name}: ${interaction.reason ?? "feedback interaction failed"}`);
      await waitForEvaluation(
        `document.body.innerText.includes(${JSON.stringify(feedbackNote)})`,
        "feedback note to appear in selected artifact",
        140,
      );
      await waitForEvaluation(
        `Boolean(document.querySelector('[data-testid="feedback-up"]:not(:disabled)'))`,
        "report feedback request to settle",
      );

      const clickedSourceChip = await evaluate(`(() => {
        const chip = document.querySelector('.artifact-ref-chip[data-artifact-id="source-001"]');
        if (!(chip instanceof HTMLButtonElement)) {
          return false;
        }
        chip.click();
        return true;
      })()`);
      assert(clickedSourceChip, `${viewport.name}: source-001 artifact chip was not clickable`);
      await waitForEvaluation(
        `document.querySelector(".detail-panel .panel-header p")?.textContent?.includes("sources/source-001.md")`,
        "source artifact detail after chip click",
      );
      await waitForEvaluation(
        `document.querySelector('[data-testid="feedback-dimension"]')?.value === "credibility"`,
        "source feedback dimension default",
      );

      const sourceFeedbackNote = `Browser smoke source feedback ${viewport.name} ${Date.now()}`;
      visibleFeedbackNote = sourceFeedbackNote;
      const sourceInteraction = await evaluate(`(() => {
        const note = ${JSON.stringify(sourceFeedbackNote)};
        const input = document.querySelector('[data-testid="feedback-note"]');
        const button = document.querySelector('[data-testid="feedback-up"]');
        if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
          return { ok: false, reason: "source feedback controls missing" };
        }
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        inputSetter?.call(input, note);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        button.click();
        return { ok: true };
      })()`);
      assert(sourceInteraction.ok, `${viewport.name}: ${sourceInteraction.reason ?? "source feedback interaction failed"}`);
      await waitForEvaluation(
        `document.querySelector(".detail-panel")?.innerText.includes(${JSON.stringify(sourceFeedbackNote)})`,
        "source feedback note to appear in selected artifact",
        140,
      );
      if (options.apiUrl && options.runId) {
        const sourceArtifact = await getJson(
          `${options.apiUrl}/api/runs/${encodeURIComponent(options.runId)}/artifacts/source-001`,
          1,
        );
        assert(
          sourceArtifact.artifact?.body?.includes(sourceFeedbackNote),
          `${viewport.name}: source feedback note was not persisted on source-001`,
        );
      }
    }

    const snapshot = await send("Runtime.evaluate", {
      expression: `(() => ({
        text: document.body.innerText,
        bodyScrollWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
        detailScrollWidth: document.querySelector(".detail-panel")?.scrollWidth ?? 0,
        detailClientWidth: document.querySelector(".detail-panel")?.clientWidth ?? 0,
        markdownScrollWidth: document.querySelector(".markdown-view")?.scrollWidth ?? 0,
        markdownClientWidth: document.querySelector(".markdown-view")?.clientWidth ?? 0
      }))()`,
      returnByValue: true,
    });
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });

    socket.close();
    return {
      viewport,
      snapshot: snapshot.result.result.value,
      screenshot: Buffer.from(screenshot.result.data, "base64"),
      events,
      stderr,
      feedbackNote: visibleFeedbackNote,
    };
  } finally {
    chrome.kill("SIGTERM");
    await sleep(100);
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function relevantBrowserIssues(events) {
  return events.filter((event) => {
    if (event.method === "Runtime.exceptionThrown") {
      return true;
    }
    if (event.method === "Log.entryAdded") {
      return ["error", "warning"].includes(event.params?.entry?.level);
    }
    if (event.method === "Network.loadingFailed") {
      const url = event.params?.requestId ?? "";
      const errorText = event.params?.errorText ?? "";
      return !/ERR_ABORTED|cancelled/i.test(`${url} ${errorText}`);
    }
    return false;
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const chromeBin = await findChrome();
  if (INTERACT_FEEDBACK && !API_URL) {
    throw new Error("Set FDR_UI_SMOKE_API_URL when FDR_UI_SMOKE_INTERACT_FEEDBACK=true.");
  }
  const seededRun = INTERACT_FEEDBACK ? await seedRunForFeedback(API_URL) : undefined;
  const results = [];

  for (const viewport of viewports) {
    const result = await withCdp(chromeBin, viewport, {
      apiUrl: API_URL,
      interactFeedback: Boolean(seededRun),
      runId: seededRun?.id,
    });
    results.push(result);
    await writeFile(path.join(OUT_DIR, `${viewport.name}.png`), result.screenshot);
    await writeFile(path.join(OUT_DIR, `${viewport.name}.txt`), result.snapshot.text);
    await writeFile(path.join(OUT_DIR, `${viewport.name}-events.json`), JSON.stringify(relevantBrowserIssues(result.events), null, 2));
  }

  for (const result of results) {
    const { snapshot, viewport } = result;
    const text = snapshot.text;
    assert(text.includes("FireDeepResearch"), `${viewport.name}: brand not rendered`);
    assert(text.includes("Start"), `${viewport.name}: start action not rendered`);
    assert(text.includes("Research Room"), `${viewport.name}: research room not rendered`);
    assert(text.includes("Report"), `${viewport.name}: artifact tabs not rendered`);
    assert(snapshot.bodyScrollWidth <= snapshot.viewportWidth + 1, `${viewport.name}: page has horizontal overflow`);
    if (snapshot.detailClientWidth > 0) {
      assert(snapshot.detailScrollWidth <= snapshot.detailClientWidth + 1, `${viewport.name}: detail panel has horizontal overflow`);
    }
    if (snapshot.markdownClientWidth > 0) {
      assert(snapshot.markdownScrollWidth <= snapshot.markdownClientWidth + 1, `${viewport.name}: markdown view has horizontal overflow`);
    }
    if (result.feedbackNote) {
      assert(text.includes(result.feedbackNote), `${viewport.name}: submitted feedback note is not visible`);
    }
    const issues = relevantBrowserIssues(result.events);
    assert(issues.length === 0, `${viewport.name}: browser issues detected in ${path.join(OUT_DIR, `${viewport.name}-events.json`)}`);
  }

  console.log(`UI smoke passed. Screenshots written to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
