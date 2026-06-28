import type { SearchTask } from "@fdr/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExaProvider, readProviderRuntimeOptionsFromEnv } from "./index";

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
