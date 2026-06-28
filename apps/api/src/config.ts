import { DEFAULT_LIMITS } from "@fdr/schemas";

const MAX_CONFIGURED_CONCURRENCY = 64;

export const RESEARCH_LIMIT_ENV = {
  maxSearchAgents: "FDR_MAX_SEARCH_AGENTS",
  maxReaderAgents: "FDR_MAX_READER_AGENTS",
  maxCritiqueAgents: "FDR_MAX_CRITIQUE_AGENTS",
} as const;

type ResearchLimitKey = keyof typeof RESEARCH_LIMIT_ENV;
type ResearchLimits = Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;

function readPositiveIntegerEnv(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_CONFIGURED_CONCURRENCY) {
    throw new Error(`${name} must be between 1 and ${MAX_CONFIGURED_CONCURRENCY}`);
  }
  return value;
}

export function readResearchLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ResearchLimits {
  const limits: ResearchLimits = {};
  for (const [key, envName] of Object.entries(RESEARCH_LIMIT_ENV) as Array<[ResearchLimitKey, string]>) {
    const value = readPositiveIntegerEnv(envName, env);
    if (value !== undefined) {
      limits[key] = value;
    }
  }
  return limits;
}
