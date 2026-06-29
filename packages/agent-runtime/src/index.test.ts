import { afterEach, describe, expect, it, vi } from "vitest";
import { createHybridRoleRunner, type RoleTurnInput } from "./index";

const roleInput: RoleTurnInput = {
  role: "planner",
  taskId: "planner-001",
  label: "Plan research",
  systemPrompt: "You are a planner.",
  userPrompt: "Create a plan with evidence needs.",
  context: "<root_user_input>Research agent runtimes</root_user_input>",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createHybridRoleRunner", () => {
  it("uses deterministic fallback output when no Pi model is configured", async () => {
    vi.stubEnv("FDR_LLM_PROVIDER", "");
    vi.stubEnv("FDR_LLM_MODEL", "");

    const runner = createHybridRoleRunner();
    await expect(runner.run(roleInput)).resolves.toMatchObject({
      usedPi: false,
      text: expect.stringContaining("Role planner completed task planner-001."),
    });
  });

  it("falls back with a reason when a configured Pi model cannot be loaded", async () => {
    const runner = createHybridRoleRunner({
      provider: "missing-provider",
      model: "missing-model",
    });
    const result = await runner.run(roleInput);

    expect(result.usedPi).toBe(false);
    expect(result.text).toContain("Pi runner fallback reason:");
    expect(result.text).toContain("missing-provider/missing-model");
  });

  it("keeps slash-containing model ids under an explicit provider", async () => {
    vi.stubEnv("FDR_LLM_PROVIDER", "missing-provider");
    vi.stubEnv("FDR_LLM_MODEL", "anthropic/claude-sonnet-4");

    const runner = createHybridRoleRunner();
    const result = await runner.run(roleInput);

    expect(result.usedPi).toBe(false);
    expect(result.text).toContain("missing-provider/anthropic/claude-sonnet-4");
  });

  it("respects abort signals in fallback mode", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before role turn"));

    const runner = createHybridRoleRunner();
    await expect(runner.run(roleInput, controller.signal)).rejects.toThrow("cancelled before role turn");
  });
});
