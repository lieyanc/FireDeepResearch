#!/usr/bin/env tsx
import "dotenv/config";
import { parseLlmModelConfig } from "../packages/schemas/src/index";
import { createHybridRoleRunner, type RoleTurnInput } from "../packages/agent-runtime/src/index";

const requireLive = process.env.FDR_REQUIRE_LIVE_SMOKE === "true" || process.env.FDR_REQUIRE_LIVE_SMOKE === "1";

function hasValue(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

const credentialEnvByProvider: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"],
  "azure-openai": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

function missingCredentialNames(provider: string): string[] {
  return (credentialEnvByProvider[provider] ?? []).filter((name) => !hasValue(process.env[name]));
}

const input: RoleTurnInput = {
  role: "planner",
  taskId: "live-llm-smoke",
  label: "Live LLM smoke",
  systemPrompt: "You are a concise research planning assistant. Reply in one sentence.",
  userPrompt: "Return one short sentence confirming that live model routing works for FireDeepResearch.",
  context: [
    "<root_user_input>",
    "Smoke-test the configured Pi model path without using any tools.",
    "</root_user_input>",
    "",
    "<task>",
    "Respond with a single sentence. Do not include secrets.",
    "</task>",
  ].join("\n"),
};

async function main() {
  const { provider, model } = parseLlmModelConfig(process.env);
  if (!provider || !model) {
    const message = "No FDR_LLM_PROVIDER/FDR_LLM_MODEL configured; skipped live Pi model smoke.";
    if (requireLive) {
      throw new Error(message);
    }
    console.log(message);
    return;
  }

  const missing = missingCredentialNames(provider);
  if (missing.length > 0) {
    const message = `Configured Pi model ${provider}/${model}, but missing likely credential env vars: ${missing.join(", ")}`;
    if (requireLive) {
      throw new Error(message);
    }
    console.log(`${message}; skipped live Pi model smoke.`);
    return;
  }

  const result = await createHybridRoleRunner({ provider, model, thinkingLevel: "off" }).run(input);
  if (!result.usedPi) {
    throw new Error(`Configured Pi model ${provider}/${model} fell back instead of using live model. Output: ${result.text.slice(0, 500)}`);
  }
  if (!result.text.trim()) {
    throw new Error(`Configured Pi model ${provider}/${model} returned empty text.`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        model: result.model,
        textPreview: result.text.trim().slice(0, 240),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
