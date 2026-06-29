import { describe, expect, it } from "vitest";
import {
  ArtifactIdInputSchema,
  ContinueRunRequestSchema,
  DomainSlugSchema,
  FeedbackRequestSchema,
  parseLlmModelConfig,
  RunCreateRequestSchema,
} from "./index";

describe("input schemas", () => {
  it("trims accepted run fields and rejects unsafe domain slugs", () => {
    expect(
      RunCreateRequestSchema.parse({
        query: "  Research auditable source workflows  ",
        domain: " ai-coding.agents ",
        maxSearchTasks: 2,
      }),
    ).toMatchObject({
      query: "Research auditable source workflows",
      domain: "ai-coding.agents",
      maxSearchTasks: 2,
    });

    expect(DomainSlugSchema.parse("")).toBeUndefined();
    expect(() => DomainSlugSchema.parse("../global")).toThrow(/domain/);
    expect(() => RunCreateRequestSchema.parse({ query: "ok", domain: "research" })).toThrow(/query/);
  });

  it("bounds continuation prompts and artifact identifiers", () => {
    expect(ArtifactIdInputSchema.parse(" final-report ")).toBe("final-report");
    expect(
      ContinueRunRequestSchema.parse({
        questionId: "question-001",
        prompt: "  Check counter evidence  ",
        maxSearchTasks: 3,
      }),
    ).toMatchObject({
      questionId: "question-001",
      prompt: "Check counter evidence",
      maxSearchTasks: 3,
    });

    expect(() => ArtifactIdInputSchema.parse("bad$id")).toThrow();
    expect(() => ContinueRunRequestSchema.parse({ questionId: "../question" })).toThrow(/questionId/);
    expect(() => ContinueRunRequestSchema.parse({ prompt: "x".repeat(4_001) })).toThrow(/prompt/);
  });

  it("normalizes optional feedback notes without allowing oversized memory writes", () => {
    expect(
      FeedbackRequestSchema.parse({
        artifactId: "claim-001",
        rating: "up",
        dimension: "correctness",
        note: "  Verified against primary source.  ",
      }),
    ).toMatchObject({
      artifactId: "claim-001",
      note: "Verified against primary source.",
    });

    expect(
      FeedbackRequestSchema.parse({
        artifactId: "claim-001",
        rating: "down",
        dimension: "citation_support",
        note: "   ",
      }).note,
    ).toBeUndefined();
    expect(() =>
      FeedbackRequestSchema.parse({
        artifactId: "claim-001",
        rating: "up",
        dimension: "report_value",
        note: "x".repeat(2_001),
      }),
    ).toThrow(/note/);
  });
});

describe("LLM model config parsing", () => {
  it("uses explicit provider when the model id itself contains slashes", () => {
    expect(
      parseLlmModelConfig({
        FDR_LLM_PROVIDER: "openrouter",
        FDR_LLM_MODEL: "anthropic/claude-sonnet-4",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      source: "FDR_LLM_PROVIDER+FDR_LLM_MODEL",
    });
  });

  it("supports provider/model shorthand when no provider env is set", () => {
    expect(
      parseLlmModelConfig({
        FDR_LLM_MODEL: "openai/gpt-4.1",
      }),
    ).toEqual({ provider: "openai", model: "gpt-4.1", source: "FDR_LLM_MODEL" });
  });

  it("reports missing or invalid provider/model combinations", () => {
    expect(parseLlmModelConfig({})).toEqual({ source: "none" });
    expect(parseLlmModelConfig({ FDR_LLM_MODEL: "gpt-4.1" })).toEqual({ model: "gpt-4.1", source: "missing-provider" });
    expect(parseLlmModelConfig({ FDR_LLM_MODEL: "openai/" })).toEqual({ source: "invalid" });
  });
});
