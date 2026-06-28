import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRole } from "@fdr/schemas";

export interface RoleTurnInput {
  role: AgentRole;
  taskId: string;
  label: string;
  systemPrompt: string;
  userPrompt: string;
  context: string;
}

export interface RoleTurnResult {
  text: string;
  usedPi: boolean;
  model?: string;
}

export interface RoleRunner {
  run(input: RoleTurnInput, signal?: AbortSignal): Promise<RoleTurnResult>;
}

export interface HybridRoleRunnerOptions {
  provider?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onDelta?: (input: RoleTurnInput, delta: string) => void;
}

function readEnvModel(): { provider?: string; model?: string } {
  const explicit = process.env.FDR_LLM_MODEL;
  if (!explicit) {
    return {};
  }
  if (explicit.includes("/")) {
    const [provider, ...rest] = explicit.split("/");
    return { provider, model: rest.join("/") };
  }
  return {
    provider: process.env.FDR_LLM_PROVIDER,
    model: explicit,
  };
}

function extractAssistantText(message: unknown): string {
  const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object") {
          const blockRecord = block as Record<string, unknown>;
          if (typeof blockRecord.text === "string") {
            return blockRecord.text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

class FallbackRoleRunner implements RoleRunner {
  async run(input: RoleTurnInput, _signal?: AbortSignal): Promise<RoleTurnResult> {
    return {
      usedPi: false,
      text: [
        `Role ${input.role} completed task ${input.taskId}.`,
        "",
        input.label,
        "",
        input.userPrompt.slice(0, 1_200),
      ].join("\n"),
    };
  }
}

class PiRoleRunner implements RoleRunner {
  constructor(private readonly options: Required<Pick<HybridRoleRunnerOptions, "provider" | "model">> & HybridRoleRunnerOptions) {}

  async run(input: RoleTurnInput, signal?: AbortSignal): Promise<RoleTurnResult> {
    const models = builtinModels();
    const model = models.getModel(inputRoleProvider(this.options.provider), this.options.model);
    if (!model) {
      throw new Error(`Pi model not found: ${this.options.provider}/${this.options.model}`);
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model,
        thinkingLevel: this.options.thinkingLevel ?? "medium",
        tools: [],
        messages: [],
      },
    });

    let streamedText = "";
    const unsubscribe = agent.subscribe((event: unknown) => {
      const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
      if (record.type !== "message_update") {
        return;
      }
      const assistantEvent = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        streamedText += assistantEvent.delta;
        this.options.onDelta?.(input, assistantEvent.delta);
      }
    });

    try {
      signal?.throwIfAborted();
      await agent.prompt(`${input.context}\n\n${input.userPrompt}`);
      signal?.throwIfAborted();
      const assistantMessages = agent.state.messages.filter((message: unknown) => {
        const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
        return record.role === "assistant";
      });
      const finalText = streamedText || extractAssistantText(assistantMessages.at(-1));
      return {
        text: finalText.trim(),
        usedPi: true,
        model: `${this.options.provider}/${this.options.model}`,
      };
    } finally {
      unsubscribe();
    }
  }
}

function inputRoleProvider(provider: string): string {
  return provider;
}

export function createHybridRoleRunner(options: HybridRoleRunnerOptions = {}): RoleRunner {
  const env = readEnvModel();
  const provider = options.provider ?? env.provider;
  const model = options.model ?? env.model;
  if (!provider || !model) {
    return new FallbackRoleRunner();
  }
  const piRunner = new PiRoleRunner({
    ...options,
    provider,
    model,
  });
  const fallback = new FallbackRoleRunner();
  return {
    async run(input, signal) {
      try {
        return await piRunner.run(input, signal);
      } catch (error) {
        const fallbackResult = await fallback.run(input, signal);
        return {
          ...fallbackResult,
          text: `${fallbackResult.text}\n\nPi runner fallback reason: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}
