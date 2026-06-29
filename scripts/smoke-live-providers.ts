#!/usr/bin/env tsx
import "dotenv/config";
import type { SearchTask } from "@fdr/schemas";
import { ExaProvider, FirecrawlProvider, TavilyProvider, type SearchProvider } from "../packages/providers/src/index";

const requireLive = process.env.FDR_REQUIRE_LIVE_SMOKE === "true" || process.env.FDR_REQUIRE_LIVE_SMOKE === "1";
const timeoutMs = Number(process.env.FDR_LIVE_PROVIDER_TIMEOUT_MS ?? 15_000);
const retryAttempts = Number(process.env.FDR_LIVE_PROVIDER_RETRY_ATTEMPTS ?? 0);
const retryDelayMs = Number(process.env.FDR_LIVE_PROVIDER_RETRY_DELAY_MS ?? 250);
const query = process.env.FDR_LIVE_PROVIDER_QUERY ?? "FireDeepResearch auditable deep research source credibility";
const firecrawlUrl = process.env.FDR_LIVE_FIRECRAWL_URL ?? "https://example.com/";

function hasValue(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const task: SearchTask = {
  id: "live-provider-smoke",
  query,
  angle: "live provider connectivity and result normalization",
  priority: 1,
  providers: ["exa", "tavily"],
};

async function smokeSearch(provider: SearchProvider) {
  const results = await provider.search({ task: { ...task, providers: [provider.name] }, maxResults: 1 });
  assert(results.length > 0, `${provider.name}: no results returned`);
  const [result] = results;
  assert(result.provider === provider.name, `${provider.name}: provider field was not normalized`);
  assert(result.title.trim().length > 0, `${provider.name}: missing title`);
  assert(/^https?:\/\//.test(result.url), `${provider.name}: invalid result URL`);
  assert((result.snippet || result.content || "").trim().length > 0, `${provider.name}: missing snippet/content`);
  return { provider: provider.name, title: result.title, url: result.url };
}

async function main() {
  const runtime = { timeoutMs, retryAttempts, retryDelayMs };
  const searchProviders: SearchProvider[] = [];
  const skipped: string[] = [];

  if (hasValue(process.env.EXA_API_KEY)) {
    searchProviders.push(new ExaProvider(process.env.EXA_API_KEY, runtime));
  } else {
    skipped.push("exa");
  }

  if (hasValue(process.env.TAVILY_API_KEY)) {
    searchProviders.push(new TavilyProvider(process.env.TAVILY_API_KEY, runtime));
  } else {
    skipped.push("tavily");
  }

  const summaries = [];
  for (const provider of searchProviders) {
    summaries.push(await smokeSearch(provider));
  }

  if (hasValue(process.env.FIRECRAWL_API_KEY)) {
    const fetched = await new FirecrawlProvider(process.env.FIRECRAWL_API_KEY, runtime).fetch(firecrawlUrl);
    assert(fetched.provider === "firecrawl", "firecrawl: provider field was not normalized");
    assert(fetched.title.trim().length > 0, "firecrawl: missing title");
    assert((fetched.markdown || fetched.html || "").trim().length > 0, "firecrawl: missing content");
    summaries.push({ provider: "firecrawl", title: fetched.title, url: fetched.url });
  } else {
    skipped.push("firecrawl");
  }

  if (summaries.length === 0) {
    const message = "No live provider credentials configured; skipped Exa/Tavily/Firecrawl smoke.";
    if (requireLive) {
      throw new Error(`${message} Set EXA_API_KEY, TAVILY_API_KEY, and/or FIRECRAWL_API_KEY.`);
    }
    console.log(message);
    return;
  }

  if (requireLive && skipped.length > 0) {
    throw new Error(`Live provider smoke ran partially but missing required provider keys: ${skipped.join(", ")}`);
  }

  console.log(JSON.stringify({ ok: true, checked: summaries, skipped }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
