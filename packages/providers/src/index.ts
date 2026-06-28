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

  constructor(private readonly apiKey: string) {}

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await fetch("https://api.exa.ai/search", {
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
      signal,
    });
    if (!response.ok) {
      throw new Error(`Exa search failed: ${response.status} ${await response.text()}`);
    }
    const payload = asRecord(await response.json());
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

  constructor(private readonly apiKey: string) {}

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await fetch("https://api.tavily.com/search", {
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
      signal,
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed: ${response.status} ${await response.text()}`);
    }
    const payload = asRecord(await response.json());
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

  constructor(private readonly apiKey: string) {}

  async fetch(url: string, signal?: AbortSignal): Promise<FetchedSource> {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "html"],
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Firecrawl fetch failed: ${response.status} ${await response.text()}`);
    }
    const payload = asRecord(await response.json());
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
  const searchProviders: SearchProvider[] = [];
  if (process.env.EXA_API_KEY && !useMock) {
    searchProviders.push(new ExaProvider(process.env.EXA_API_KEY));
  }
  if (process.env.TAVILY_API_KEY && !useMock) {
    searchProviders.push(new TavilyProvider(process.env.TAVILY_API_KEY));
  }
  if (searchProviders.length === 0 || useMock) {
    searchProviders.push(new MockSearchProvider());
  }

  const fetchProvider =
    process.env.FIRECRAWL_API_KEY && !useMock
      ? new FirecrawlProvider(process.env.FIRECRAWL_API_KEY)
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
  if (/utm_|sponsored|affiliate/i.test(input.url + input.title)) {
    score -= 0.12;
  }
  return Math.max(0.05, Math.min(0.98, Number(score.toFixed(2))));
}
