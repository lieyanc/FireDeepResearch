import type { SearchTask } from "@fdr/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExaProvider, FirecrawlProvider, TavilyProvider, inferSourceKind, readProviderRuntimeOptionsFromEnv } from "./index";

const task: SearchTask = {
  id: "task-1",
  query: "reliable provider retry",
  angle: "resilience",
  priority: 0.8,
  providers: ["exa"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider resilience", () => {
  it("retries transient HTTP failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary overload", { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              title: "Recovered source",
              url: "https://example.com/recovered",
              summary: "Recovered after retry",
              text: "Recovered source body",
              score: 0.91,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ExaProvider("test-key", {
      timeoutMs: 1_000,
      retryAttempts: 1,
      retryDelayMs: 0,
    });
    const results = await provider.search({ task, maxResults: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider: "exa",
      title: "Recovered source",
      url: "https://example.com/recovered",
      score: 0.91,
    });
  });

  it("does not retry non-transient HTTP failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ExaProvider("test-key", {
      timeoutMs: 1_000,
      retryAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(provider.search({ task, maxResults: 1 })).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes Tavily search results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        results: [
          {
            title: "Tavily source",
            url: "https://example.com/tavily",
            content: "Short content summary",
            raw_content: "Full raw content from Tavily",
            published_date: "2026-06-01",
            score: 0.72,
          },
          {
            title: "Missing URL",
            content: "Should be dropped",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new TavilyProvider("test-key", {
      timeoutMs: 1_000,
      retryAttempts: 0,
      retryDelayMs: 0,
    });
    const results = await provider.search({ task: { ...task, providers: ["tavily"] }, maxResults: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      {
        provider: "tavily",
        title: "Tavily source",
        url: "https://example.com/tavily",
        snippet: "Short content summary",
        content: "Full raw content from Tavily",
        publishedAt: "2026-06-01",
        score: 0.72,
      },
    ]);
  });

  it("normalizes Firecrawl scrape responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          markdown: "# Firecrawl page\n\nExtracted markdown.",
          html: "<h1>Firecrawl page</h1>",
          metadata: {
            title: "Firecrawl page",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new FirecrawlProvider("test-key", {
      timeoutMs: 1_000,
      retryAttempts: 0,
      retryDelayMs: 0,
    });
    const result = await provider.fetch("https://example.com/firecrawl");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "firecrawl",
      title: "Firecrawl page",
      url: "https://example.com/firecrawl",
      markdown: "# Firecrawl page\n\nExtracted markdown.",
      html: "<h1>Firecrawl page</h1>",
    });
    expect(Date.parse(result.fetchedAt)).not.toBeNaN();
  });
});

describe("readProviderRuntimeOptionsFromEnv", () => {
  it("parses bounded provider timeout and retry options", () => {
    expect(
      readProviderRuntimeOptionsFromEnv({
        FDR_PROVIDER_TIMEOUT_MS: "1500",
        FDR_PROVIDER_RETRY_ATTEMPTS: "3",
        FDR_PROVIDER_RETRY_DELAY_MS: "50",
      }),
    ).toEqual({
      timeoutMs: 1500,
      retryAttempts: 3,
      retryDelayMs: 50,
    });
  });

  it("rejects unsafe provider runtime values", () => {
    expect(() => readProviderRuntimeOptionsFromEnv({ FDR_PROVIDER_TIMEOUT_MS: "999" })).toThrow(/between 1000 and 120000/);
    expect(() => readProviderRuntimeOptionsFromEnv({ FDR_PROVIDER_RETRY_ATTEMPTS: "6" })).toThrow(/between 0 and 5/);
    expect(() => readProviderRuntimeOptionsFromEnv({ FDR_PROVIDER_RETRY_DELAY_MS: "fast" })).toThrow(/must be an integer/);
  });
});

describe("inferSourceKind", () => {
  it("ignores query parameters when inferring source kind", () => {
    expect(
      inferSourceKind(
        "https://demo.firedeepresearch.local/community/practitioner-reports?angle=primary%20evidence%20and%20official%20sources",
        "Practitioner reports show productivity gains but uneven trust",
      ),
    ).toBe("forum");
    expect(
      inferSourceKind(
        "https://demo.firedeepresearch.local/analysis/workflow-differentiation?q=official%20primary%20evidence",
        "Market analysis: differentiation is moving from autocomplete to agent workflow",
      ),
    ).toBe("media");
  });
});
