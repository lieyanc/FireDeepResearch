import "dotenv/config";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { MarkdownStore, getDefaultDataDir } from "@fdr/knowledge";
import { createProviderRegistryFromEnv, type ProviderRegistry } from "@fdr/providers";
import { ResearchController } from "@fdr/research-core";
import {
  ArtifactIdInputSchema,
  ContinueRunRequestSchema,
  DomainSlugSchema,
  FeedbackRequestSchema,
  parseLlmModelConfig,
  RunCreateRequestSchema,
  type ResearchEvent,
} from "@fdr/schemas";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { readResearchLimitsFromEnv } from "./config";

export interface ApiAppDependencies {
  store: MarkdownStore;
  providers: ProviderRegistry;
  research: ResearchController;
  llmRuntime?: LlmRuntimeInfo;
}

export interface LlmRuntimeInfo {
  mode: "fallback" | "pi";
  provider?: string;
  model?: string;
}

export function readLlmRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): LlmRuntimeInfo {
  const config = parseLlmModelConfig(env);
  return config.provider && config.model ? { mode: "pi", provider: config.provider, model: config.model } : { mode: "fallback" };
}

export function createDefaultApiDependencies(): ApiAppDependencies {
  const store = new MarkdownStore({ dataDir: getDefaultDataDir() });
  const providers = createProviderRegistryFromEnv();
  const research = new ResearchController({ store, providers, limits: readResearchLimitsFromEnv() });
  return { store, providers, research, llmRuntime: readLlmRuntimeFromEnv() };
}

function jsonError(message: string, status = 400) {
  return new HTTPException(status as 400, { message });
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
}

function formatSse(event: ResearchEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseValue<T>(value: unknown, parse: (value: unknown) => T): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw jsonError(formatZodError(error));
    }
    throw error;
  }
}

const localDevOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

export function resolveCorsOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configuredOrigins = env.FDR_CORS_ORIGIN?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configuredOrigins?.length) {
    if (configuredOrigins.includes("*")) {
      return "*";
    }
    return configuredOrigins.includes(origin) ? origin : undefined;
  }

  return localDevOriginPattern.test(origin) ? origin : undefined;
}

async function parseJson<T>(request: Request, parse: (value: unknown) => T): Promise<T> {
  try {
    return parseValue(await request.json(), parse);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    if (error instanceof ZodError) {
      throw jsonError(formatZodError(error));
    }
    throw jsonError("Invalid JSON body");
  }
}

export function createApiApp({ store, providers, research, llmRuntime = readLlmRuntimeFromEnv() }: ApiAppDependencies): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => resolveCorsOrigin(origin),
      allowHeaders: ["content-type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/api/health", (c) => {
    const limits = research.getLimits();
    return c.json({
      ok: true,
      dataDir: store.dataDir,
      searchProviders: providers.searchProviders.map((provider) => provider.name),
      fetchProvider: providers.fetchProvider.name,
      llmRuntime,
      researchLimits: {
        maxSearchAgents: limits.maxSearchAgents,
        maxReaderAgents: limits.maxReaderAgents,
        maxCritiqueAgents: limits.maxCritiqueAgents,
      },
    });
  });

  app.get("/api/runs", async (c) => {
    return c.json({ runs: await research.listRuns() });
  });

  app.get("/api/memory", async (c) => {
    const domain = parseValue(c.req.query("domain"), (value) => DomainSlugSchema.parse(value));
    return c.json({ memory: await research.getMemory(domain) });
  });

  app.post("/api/runs", async (c) => {
    const input = await parseJson(c.req.raw, (value) => RunCreateRequestSchema.parse(value));
    const run = await research.createRun(input);
    return c.json({ run }, 201);
  });

  app.get("/api/runs/:runId", async (c) => {
    const run = await research.getRun(c.req.param("runId"));
    if (!run) {
      throw jsonError("Run not found", 404);
    }
    return c.json({ run });
  });

  app.get("/api/runs/:runId/events/history", async (c) => {
    return c.json({ events: await research.getEvents(c.req.param("runId")) });
  });

  app.get("/api/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    const history = await research.getEvents(runId);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (payload: string) => {
          if (!closed) {
            controller.enqueue(encoder.encode(payload));
          }
        };

        for (const event of history) {
          send(formatSse(event));
        }

        const unsubscribe = research.subscribe((event) => {
          if (event.runId === runId) {
            send(formatSse(event));
          }
        });

        const keepAlive = setInterval(() => {
          send(`: heartbeat ${new Date().toISOString()}\n\n`);
        }, 15_000);

        c.req.raw.signal.addEventListener(
          "abort",
          () => {
            closed = true;
            clearInterval(keepAlive);
            unsubscribe();
            try {
              controller.close();
            } catch {
              // The client may already have closed the stream.
            }
          },
          { once: true },
        );
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  });

  app.get("/api/runs/:runId/artifacts", async (c) => {
    return c.json({ artifacts: await research.listArtifacts(c.req.param("runId")) });
  });

  app.get("/api/runs/:runId/artifacts/content", async (c) => {
    const artifactPath = c.req.query("path");
    if (!artifactPath) {
      throw jsonError("Missing artifact path");
    }
    const artifact = await research.readArtifact(c.req.param("runId"), artifactPath);
    if (!artifact) {
      throw jsonError("Artifact not found", 404);
    }
    return c.json({ artifact });
  });

  app.get("/api/runs/:runId/artifacts/:artifactId", async (c) => {
    const artifactId = parseValue(c.req.param("artifactId"), (value) => ArtifactIdInputSchema.parse(value));
    const artifact = await research.readArtifactById(c.req.param("runId"), artifactId);
    if (!artifact) {
      throw jsonError("Artifact not found", 404);
    }
    return c.json({ artifact });
  });

  app.post("/api/runs/:runId/feedback", async (c) => {
    const feedback = await parseJson(c.req.raw, (value) => FeedbackRequestSchema.parse(value));
    const artifact = await research.addFeedback(c.req.param("runId"), feedback);
    return c.json({ artifact }, 201);
  });

  app.post("/api/runs/:runId/continue", async (c) => {
    const input = await parseJson(c.req.raw, (value) => ContinueRunRequestSchema.parse(value));
    const run = await research.continueRun(c.req.param("runId"), input);
    return c.json({ run }, 202);
  });

  app.post("/api/runs/:runId/cancel", async (c) => {
    const cancelled = await research.cancelRun(c.req.param("runId"));
    return c.json({ cancelled });
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof ZodError) {
      return c.json({ error: formatZodError(error) }, 400);
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof Error && /already active/i.test(error.message)) {
      return c.json({ error: error.message }, 409);
    }
    console.error(error);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  return app;
}

const port = Number(process.env.FDR_API_PORT ?? 8787);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApiApp(createDefaultApiDependencies());
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`FireDeepResearch API listening on http://localhost:${info.port}`);
    },
  );
}
