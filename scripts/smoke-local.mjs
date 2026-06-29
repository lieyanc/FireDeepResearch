#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const apiPort = Number(process.env.FDR_LOCAL_SMOKE_API_PORT ?? 19_780 + Math.floor(Math.random() * 500));
const webPort = Number(process.env.FDR_LOCAL_SMOKE_WEB_PORT ?? 18_080 + Math.floor(Math.random() * 500));
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}/`;
const uiOutDir = process.env.FDR_LOCAL_SMOKE_OUT_DIR ?? path.join(tmpdir(), "fdr-local-smoke-ui");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`${label} did not become ready`);
}

async function waitForHttpOk(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`${label} did not become ready`);
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

function startProcess(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
      log += `\n${label} exited with code=${code} signal=${signal}\n`;
    }
  });
  return { child, getLog: () => log };
}

async function runSmokeUi(env) {
  const child = spawn("node", ["scripts/smoke-ui.mjs"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise((resolve) => {
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`smoke-ui failed:\n${output}`);
  }
  return output.trim();
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fdr-local-smoke-data-"));
  const logDir = await mkdtemp(path.join(tmpdir(), "fdr-local-smoke-logs-"));
  let failed = false;
  if (!process.env.FDR_LOCAL_SMOKE_OUT_DIR) {
    await rm(uiOutDir, { recursive: true, force: true });
  }
  await mkdir(uiOutDir, { recursive: true });
  const api = startProcess("api", "pnpm", ["--filter", "@fdr/api", "start"], {
    ...process.env,
    FDR_API_PORT: String(apiPort),
    FDR_DATA_DIR: dataDir,
    FDR_USE_MOCK_PROVIDERS: "true",
    FDR_LLM_PROVIDER: "",
    FDR_LLM_MODEL: "",
  });
  const web = startProcess("web", "pnpm", ["--filter", "@fdr/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    ...process.env,
    VITE_API_URL: apiUrl,
  });

  try {
    const health = await waitForJson(`${apiUrl}/api/health`, "API");
    if (health.dataDir !== dataDir) {
      throw new Error(`API dataDir mismatch: ${health.dataDir}`);
    }
    await waitForHttpOk(webUrl, "Web");
    const uiOutput = await runSmokeUi({
      ...process.env,
      FDR_UI_SMOKE_API_URL: apiUrl,
      FDR_UI_SMOKE_INTERACT_FEEDBACK: "true",
      FDR_UI_SMOKE_URL: webUrl,
      FDR_UI_SMOKE_OUT_DIR: uiOutDir,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          apiUrl,
          webUrl,
          dataDir,
          dataDirKept: Boolean(process.env.FDR_LOCAL_SMOKE_KEEP_DATA),
          uiOutDir,
          uiOutput,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failed = true;
    await writeFile(path.join(logDir, "api.log"), api.getLog());
    await writeFile(path.join(logDir, "web.log"), web.getLog());
    console.error(`Local smoke failed. Logs written to ${logDir}`);
    throw error;
  } finally {
    await Promise.all([terminateChild(web.child), terminateChild(api.child)]);
    if (failed || process.env.FDR_LOCAL_SMOKE_KEEP_DATA) {
      await writeFile(path.join(logDir, "api.log"), api.getLog());
      await writeFile(path.join(logDir, "web.log"), web.getLog());
      if (process.env.FDR_LOCAL_SMOKE_KEEP_DATA) {
        console.log(`Kept local smoke data at ${dataDir}`);
      } else {
        await rm(dataDir, { recursive: true, force: true });
      }
      console.log(`Kept local smoke logs at ${logDir}`);
    } else {
      await rm(dataDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
