import { describe, expect, it } from "vitest";
import { readResearchLimitsFromEnv } from "./config";

describe("readResearchLimitsFromEnv", () => {
  it("returns only configured research concurrency limits", () => {
    expect(
      readResearchLimitsFromEnv({
        FDR_MAX_SEARCH_AGENTS: "12",
        FDR_MAX_READER_AGENTS: "16",
        FDR_MAX_CRITIQUE_AGENTS: "5",
      }),
    ).toEqual({
      maxSearchAgents: 12,
      maxReaderAgents: 16,
      maxCritiqueAgents: 5,
    });
  });

  it("ignores empty values", () => {
    expect(
      readResearchLimitsFromEnv({
        FDR_MAX_SEARCH_AGENTS: "",
        FDR_MAX_READER_AGENTS: " ",
      }),
    ).toEqual({});
  });

  it("rejects unsafe or malformed concurrency limits", () => {
    expect(() => readResearchLimitsFromEnv({ FDR_MAX_SEARCH_AGENTS: "0" })).toThrow(/between 1 and 64/);
    expect(() => readResearchLimitsFromEnv({ FDR_MAX_READER_AGENTS: "1.5" })).toThrow(/positive integer/);
    expect(() => readResearchLimitsFromEnv({ FDR_MAX_CRITIQUE_AGENTS: "65" })).toThrow(/between 1 and 64/);
  });
});
