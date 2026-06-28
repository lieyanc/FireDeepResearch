import type { SearchTask, SourceKind } from "@fdr/schemas";

export interface SearchQuery {
  task: SearchTask;
  maxResults: number;
}

export interface SearchResult {
  provider: string;
  title: string;
  url: string;
  snippet: string;
  content?: string;
  publishedAt?: string;
  score?: number;
}

export interface FetchedSource {
  provider: string;
  url: string;
  title: string;
  markdown: string;
  html?: string;
  fetchedAt: string;
}

export interface SearchProvider {
  name: "exa" | "tavily" | "mock";
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]>;
}

export interface FetchProvider {
  name: "firecrawl" | "mock";
  fetch(url: string, signal?: AbortSignal): Promise<FetchedSource>;
}

export interface ProviderRegistry {
  searchProviders: SearchProvider[];
  fetchProvider: FetchProvider;
}

export interface ProviderRuntimeOptions {
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

const DEFAULT_PROVIDER_RUNTIME: Required<ProviderRuntimeOptions> = {
  timeoutMs: 20_000,
  retryAttempts: 2,
  retryDelayMs: 400,
};

const PROVIDER_TIMEOUT_ENV = "FDR_PROVIDER_TIMEOUT_MS";
const PROVIDER_RETRY_ATTEMPTS_ENV = "FDR_PROVIDER_RETRY_ATTEMPTS";
const PROVIDER_RETRY_DELAY_ENV = "FDR_PROVIDER_RETRY_DELAY_MS";

function resolveProviderRuntime(options: ProviderRuntimeOptions = {}): Required<ProviderRuntimeOptions> {
  return { ...DEFAULT_PROVIDER_RUNTIME, ...options };
}

function readBoundedIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function readProviderRuntimeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderRuntimeOptions {
  return {
    timeoutMs: readBoundedIntegerEnv(env, PROVIDER_TIMEOUT_ENV, 1_000, 120_000),
    retryAttempts: readBoundedIntegerEnv(env, PROVIDER_RETRY_ATTEMPTS_ENV, 0, 5),
    retryDelayMs: readBoundedIntegerEnv(env, PROVIDER_RETRY_DELAY_ENV, 0, 10_000),
  };
}

class ProviderHttpError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${label} failed: HTTP ${status}${body ? ` ${body}` : ""}`);
  }
}

class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`provider request timed out after ${timeoutMs}ms`);
  }
}

function compactBody(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError) {
    return true;
  }
  if (error instanceof ProviderHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Provider request aborted"));
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new ProviderTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function withProviderRetry<T>(
  label: string,
  runtime: Required<ProviderRuntimeOptions>,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  let attemptsMade = 0;
  for (let attempt = 0; attempt <= runtime.retryAttempts; attempt += 1) {
    attemptsMade = attempt + 1;
    try {
      return await withRequestTimeout(operation, runtime.timeoutMs, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt >= runtime.retryAttempts || !isRetryableProviderError(error)) {
        break;
      }
      await wait(runtime.retryDelayMs * (attempt + 1), signal);
    }
  }
  throw new Error(`${label} failed after ${attemptsMade} attempt(s): ${errorMessage(lastError)}`);
}

async function fetchJson(
  label: string,
  input: string,
  init: RequestInit,
  runtime: Required<ProviderRuntimeOptions>,
  signal?: AbortSignal,
): Promise<unknown> {
  return withProviderRetry(
    label,
    runtime,
    async (attemptSignal) => {
      const response = await fetch(input, { ...init, signal: attemptSignal });
      if (!response.ok) {
        throw new ProviderHttpError(label, response.status, compactBody(await response.text()));
      }
      return response.json();
    },
    signal,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function shouldUseMockProviders(): boolean {
  const mode = process.env.FDR_USE_MOCK_PROVIDERS ?? "auto";
  if (mode === "true" || mode === "1") {
    return true;
  }
  if (mode === "false" || mode === "0") {
    return false;
  }
  return !process.env.EXA_API_KEY && !process.env.TAVILY_API_KEY;
}

export class ExaProvider implements SearchProvider {
  readonly name = "exa" as const;
  private readonly runtime: Required<ProviderRuntimeOptions>;

  constructor(private readonly apiKey: string, options?: ProviderRuntimeOptions) {
    this.runtime = resolveProviderRuntime(options);
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const payload = asRecord(
      await fetchJson(
        `${this.name}.search`,
        "https://api.exa.ai/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: JSON.stringify({
            query: query.task.query,
            numResults: query.maxResults,
            type: "auto",
            contents: {
              text: true,
              highlights: true,
              summary: true,
            },
          }),
        },
        this.runtime,
        signal,
      ),
    );
    return asArray(payload.results).map((item) => {
      const record = asRecord(item);
      const highlights = asArray(record.highlights).map((highlight) => asString(highlight)).filter(Boolean);
      return {
        provider: this.name,
        title: asString(record.title, "Untitled Exa result"),
        url: asString(record.url),
        snippet: asString(record.summary) || highlights.join("\n") || asString(record.text).slice(0, 500),
        content: asString(record.text),
        publishedAt: asString(record.publishedDate) || undefined,
        score: typeof record.score === "number" ? record.score : undefined,
      };
    }).filter((result) => result.url);
  }
}

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily" as const;
  private readonly runtime: Required<ProviderRuntimeOptions>;

  constructor(private readonly apiKey: string, options?: ProviderRuntimeOptions) {
    this.runtime = resolveProviderRuntime(options);
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const payload = asRecord(
      await fetchJson(
        `${this.name}.search`,
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            api_key: this.apiKey,
            query: query.task.query,
            max_results: query.maxResults,
            search_depth: "advanced",
            include_answer: false,
            include_raw_content: true,
          }),
        },
        this.runtime,
        signal,
      ),
    );
    return asArray(payload.results).map((item) => {
      const record = asRecord(item);
      return {
        provider: this.name,
        title: asString(record.title, "Untitled Tavily result"),
        url: asString(record.url),
        snippet: asString(record.content) || asString(record.raw_content).slice(0, 500),
        content: asString(record.raw_content) || asString(record.content),
        publishedAt: asString(record.published_date) || undefined,
        score: typeof record.score === "number" ? record.score : undefined,
      };
    }).filter((result) => result.url);
  }
}

export class FirecrawlProvider implements FetchProvider {
  readonly name = "firecrawl" as const;
  private readonly runtime: Required<ProviderRuntimeOptions>;

  constructor(private readonly apiKey: string, options?: ProviderRuntimeOptions) {
    this.runtime = resolveProviderRuntime(options);
  }

  async fetch(url: string, signal?: AbortSignal): Promise<FetchedSource> {
    const payload = asRecord(
      await fetchJson(
        `${this.name}.fetch`,
        "https://api.firecrawl.dev/v1/scrape",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url,
            formats: ["markdown", "html"],
          }),
        },
        this.runtime,
        signal,
      ),
    );
    const data = asRecord(payload.data);
    const metadata = asRecord(data.metadata);
    return {
      provider: this.name,
      url,
      title: asString(metadata.title, url),
      markdown: asString(data.markdown) || asString(data.html),
      html: asString(data.html) || undefined,
      fetchedAt: new Date().toISOString(),
    };
  }
}

const MOCK_CONTENT = [
  {
    title: "Official enterprise documentation emphasizes governance and audit controls",
    url: "https://demo.firedeepresearch.local/official/enterprise-governance",
    snippet:
      "Official product documentation positions enterprise adoption around permissioning, audit logs, deployment controls, and integration governance.",
    content:
      "Enterprise buyers repeatedly ask for permissioning, audit logs, deployment controls, and integration governance before broad coding-agent rollout. Model quality matters, but internal approval depends on whether teams can prove who changed what, which repositories were exposed, and how generated code is reviewed.",
    sourceKind: "official" as SourceKind,
  },
  {
    title: "Practitioner reports show productivity gains but uneven trust",
    url: "https://demo.firedeepresearch.local/community/practitioner-reports",
    snippet:
      "Developer community reports describe meaningful speedups for routine edits while warning that long-horizon autonomy still needs review.",
    content:
      "Practitioners report that coding agents accelerate routine edits, migration chores, and test generation. The same reports warn that long-horizon tasks still require strong review, especially when agents touch unfamiliar systems or rely on stale context.",
    sourceKind: "forum" as SourceKind,
  },
  {
    title: "Market analysis: differentiation is moving from autocomplete to agent workflow",
    url: "https://demo.firedeepresearch.local/analysis/workflow-differentiation",
    snippet:
      "Market observers argue that coding-agent vendors increasingly compete on workflow integration, context management, and enterprise controls.",
    content:
      "The visible marketing battle focuses on model benchmarks, but adoption signals point toward workflow integration, context management, security posture, and governance. Vendors with strong enterprise distribution can convert faster, while startups need a wedge in highly trusted workflows.",
    sourceKind: "media" as SourceKind,
  },
  {
    title: "Procurement notes highlight source-code exposure and compliance concerns",
    url: "https://demo.firedeepresearch.local/primary/procurement-notes",
    snippet:
      "Procurement teams treat source-code exposure, dependency policy, auditability, and data retention as gating concerns for agentic coding tools.",
    content:
      "Procurement reviews identify source-code exposure, dependency policy, auditability, and data retention as gating concerns. Teams are more willing to pilot narrow tools when evidence trails, permission boundaries, and rollback paths are visible.",
    sourceKind: "primary" as SourceKind,
  },
  {
    title: "Counter-signal: individual developers still choose tools by speed and familiarity",
    url: "https://demo.firedeepresearch.local/community/individual-preference",
    snippet:
      "Individual developers often choose coding agents based on speed, editor fit, and perceived helpfulness rather than formal governance.",
    content:
      "Individual developers often choose coding assistants based on speed, editor fit, and perceived helpfulness. This creates bottom-up adoption pressure even when enterprise governance is not complete, but it can also produce shadow adoption risk.",
    sourceKind: "forum" as SourceKind,
  },
];

export class MockSearchProvider implements SearchProvider {
  readonly name = "mock" as const;

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const normalized = query.task.query.toLowerCase();
    const ranked = MOCK_CONTENT.map((item, index) => ({
      provider: this.name,
      title: `${item.title} (${query.task.angle})`,
      url: `${item.url}?angle=${encodeURIComponent(query.task.angle)}&q=${encodeURIComponent(normalized.slice(0, 40))}`,
      snippet: item.snippet,
      content: item.content,
      score: 1 - index * 0.08,
    }));
    return ranked.slice(0, query.maxResults);
  }
}

export class MockFetchProvider implements FetchProvider {
  readonly name = "mock" as const;

  async fetch(url: string): Promise<FetchedSource> {
    const matched = MOCK_CONTENT.find((item) => url.startsWith(item.url)) ?? MOCK_CONTENT[0];
    return {
      provider: this.name,
      url,
      title: matched.title,
      markdown: `# ${matched.title}\n\n${matched.content}\n`,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export function createProviderRegistryFromEnv(): ProviderRegistry {
  const useMock = shouldUseMockProviders();
  const runtime = readProviderRuntimeOptionsFromEnv();
  const searchProviders: SearchProvider[] = [];
  if (process.env.EXA_API_KEY && !useMock) {
    searchProviders.push(new ExaProvider(process.env.EXA_API_KEY, runtime));
  }
  if (process.env.TAVILY_API_KEY && !useMock) {
    searchProviders.push(new TavilyProvider(process.env.TAVILY_API_KEY, runtime));
  }
  if (searchProviders.length === 0 || useMock) {
    searchProviders.push(new MockSearchProvider());
  }

  const fetchProvider =
    process.env.FIRECRAWL_API_KEY && !useMock
      ? new FirecrawlProvider(process.env.FIRECRAWL_API_KEY, runtime)
      : new MockFetchProvider();

  return {
    searchProviders,
    fetchProvider,
  };
}

export function inferSourceKind(url: string, title: string): SourceKind {
  const combined = `${url} ${title}`.toLowerCase();
  if (combined.includes("docs") || combined.includes("official") || combined.includes("/official/")) {
    return "official";
  }
  if (combined.includes("arxiv") || combined.includes("paper") || combined.includes("academic")) {
    return "academic";
  }
  if (combined.includes("sec.gov") || combined.includes("regulator") || combined.includes("policy")) {
    return "regulatory";
  }
  if (combined.includes("primary") || combined.includes("procurement")) {
    return "primary";
  }
  if (combined.includes("forum") || combined.includes("community") || combined.includes("reddit")) {
    return "forum";
  }
  if (combined.includes("blog")) {
    return "blog";
  }
  if (combined.includes("analysis") || combined.includes("news") || combined.includes("media")) {
    return "media";
  }
  return "unknown";
}

export function scoreSourceCredibility(input: {
  sourceKind: SourceKind;
  url: string;
  title: string;
  hasContent: boolean;
  providerScore?: number;
  reputationAdjustment?: number;
}): number {
  const baseByKind: Record<SourceKind, number> = {
    official: 0.86,
    primary: 0.82,
    academic: 0.84,
    regulatory: 0.88,
    media: 0.65,
    blog: 0.52,
    forum: 0.48,
    unknown: 0.42,
  };
  let score = baseByKind[input.sourceKind];
  if (input.hasContent) {
    score += 0.05;
  }
  if (input.providerScore !== undefined) {
    score += Math.min(0.06, Math.max(0, input.providerScore * 0.06));
  }
  if (input.reputationAdjustment !== undefined) {
    score += input.reputationAdjustment;
  }
  if (/utm_|sponsored|affiliate/i.test(input.url + input.title)) {
    score -= 0.12;
  }
  return Math.max(0.05, Math.min(0.98, Number(score.toFixed(2))));
}
