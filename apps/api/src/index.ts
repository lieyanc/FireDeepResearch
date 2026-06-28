import "dotenv/config";
import { serve } from "@hono/node-server";
import { MarkdownStore, getDefaultDataDir } from "@fdr/knowledge";
import { createProviderRegistryFromEnv } from "@fdr/providers";
import { ResearchController } from "@fdr/research-core";
import { ContinueRunRequestSchema, FeedbackRequestSchema, RunCreateRequestSchema, type ResearchEvent } from "@fdr/schemas";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { readResearchLimitsFromEnv } from "./config";

const app = new Hono();
const store = new MarkdownStore({ dataDir: getDefaultDataDir() });
const providers = createProviderRegistryFromEnv();
const research = new ResearchController({ store, providers, limits: readResearchLimitsFromEnv() });

function jsonError(message: string, status = 400) {
  return new HTTPException(status as 400, { message });
}

function formatSse(event: ResearchEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function parseJson<T>(request: Request, parse: (value: unknown) => T): Promise<T> {
  try {
    return parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) {
      throw jsonError(error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    throw jsonError("Invalid JSON body");
  }
}

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
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
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(payload));
        }
      };

      const history = await research.getEvents(runId);
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

app.post("/api/runs/:runId/cancel", (c) => {
  const cancelled = research.cancelRun(c.req.param("runId"));
  return c.json({ cancelled });
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  console.error(error);
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
});

const port = Number(process.env.FDR_API_PORT ?? 8787);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`FireDeepResearch API listening on http://localhost:${info.port}`);
  },
);

export { app, research };
