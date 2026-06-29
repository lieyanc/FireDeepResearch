#!/usr/bin/env tsx
import "dotenv/config";
import { parseLlmModelConfig } from "../packages/schemas/src/index";

const requireLive = process.env.FDR_REQUIRE_LIVE_SMOKE === "true" || process.env.FDR_REQUIRE_LIVE_SMOKE === "1";

const providerCredentials = {
  exa: ["EXA_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  firecrawl: ["FIRECRAWL_API_KEY"],
} as const;

const llmCredentialEnvByProvider: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"],
  "azure-openai": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

function hasValue(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function missingEnv(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return names.filter((name) => !hasValue(env[name]));
}

function statusFor(names: readonly string[]) {
  const missing = missingEnv(names);
  return {
    configured: missing.length === 0,
    requiredEnv: names,
    missingEnv: missing,
  };
}

async function main() {
  const providers = Object.fromEntries(
    Object.entries(providerCredentials).map(([name, envNames]) => [name, statusFor(envNames)]),
  );
  const configuredProviders = Object.values(providers).filter((provider) => provider.configured).length;

  const llm = parseLlmModelConfig(process.env);
  const llmMissing =
    llm.provider && llm.model
      ? missingEnv(llmCredentialEnvByProvider[llm.provider] ?? [])
      : llm.source === "missing-provider"
        ? ["FDR_LLM_PROVIDER"]
        : llm.source === "invalid"
          ? ["FDR_LLM_MODEL"]
          : [];

  const knownLlmProvider = !llm.provider || Object.hasOwn(llmCredentialEnvByProvider, llm.provider);
  const llmReady = Boolean(llm.provider && llm.model && knownLlmProvider && llmMissing.length === 0);
  const problems: string[] = [];

  if (configuredProviders === 0) {
    problems.push("No commercial provider credentials configured: set at least one of EXA_API_KEY, TAVILY_API_KEY, FIRECRAWL_API_KEY.");
  }
  if (llm.source === "none") {
    problems.push("No live Pi model configured: set FDR_LLM_MODEL=provider/model, or FDR_LLM_PROVIDER plus FDR_LLM_MODEL.");
  } else if (llm.source === "missing-provider") {
    problems.push("FDR_LLM_MODEL is set without a provider: set FDR_LLM_PROVIDER or use FDR_LLM_MODEL=provider/model.");
  } else if (llm.source === "invalid") {
    problems.push("FDR_LLM_MODEL must include both provider and model when using provider/model syntax.");
  } else if (!knownLlmProvider) {
    problems.push(`Unknown Pi provider '${llm.provider}'. Add its credential mapping to scripts/smoke-live-readiness.ts and smoke-live-llm.ts.`);
  } else if (llmMissing.length > 0) {
    problems.push(`Configured Pi model ${llm.provider}/${llm.model} is missing likely credential env vars: ${llmMissing.join(", ")}.`);
  }

  const report = {
    ok: !requireLive || problems.length === 0,
    strict: requireLive,
    providers,
    llm: {
      configured: llmReady,
      provider: llm.provider,
      model: llm.model,
      source: llm.source,
      requiredEnv: llm.provider ? (llmCredentialEnvByProvider[llm.provider] ?? []) : [],
      missingEnv: llmMissing,
    },
    problems,
  };

  const missingProviderKeys = Object.entries(providers)
    .flatMap(([provider, status]) => (status.configured ? [] : status.missingEnv.map((name) => `${provider}:${name}`)));
  if (requireLive && missingProviderKeys.length > 0) {
    problems.unshift(`Strict live provider acceptance requires all provider keys: ${missingProviderKeys.join(", ")}.`);
    report.ok = false;
    report.problems = problems;
  }

  if (requireLive && problems.length > 0) {
    console.error(JSON.stringify(report, null, 2));
    throw new Error("Live readiness failed; configure the missing provider/model credentials before strict live acceptance.");
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
