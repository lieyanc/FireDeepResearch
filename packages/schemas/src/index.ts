import { z } from "zod";

export const AgentRoleSchema = z.enum([
  "planner",
  "search-strategist",
  "source-reader",
  "claim-extractor",
  "skeptic",
  "insight-miner",
  "citation-auditor",
  "report-writer",
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ArtifactKindSchema = z.enum([
  "user_input",
  "plan",
  "blackboard",
  "source",
  "claim",
  "question",
  "critique",
  "insight",
  "audit",
  "report",
  "feedback",
]);

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "finished",
  "failed",
  "cancelled",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const SourceKindSchema = z.enum([
  "official",
  "primary",
  "academic",
  "regulatory",
  "media",
  "blog",
  "forum",
  "unknown",
]);

export type SourceKind = z.infer<typeof SourceKindSchema>;

export const ClaimKindSchema = z.enum([
  "fact",
  "number",
  "date",
  "causal",
  "forecast",
  "judgment",
]);

export type ClaimKind = z.infer<typeof ClaimKindSchema>;

export const ClaimStatusSchema = z.enum([
  "draft",
  "verified",
  "challenged",
  "weak",
  "conflicting",
  "unsupported",
]);

export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ResearchRunSchema = z.object({
  id: z.string(),
  query: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  artifactRoot: z.string(),
});

export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export const ArtifactRefSchema = z.object({
  id: z.string(),
  kind: ArtifactKindSchema,
  title: z.string(),
  path: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactDocumentSchema = ArtifactRefSchema.extend({
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
});

export type ArtifactDocument = z.infer<typeof ArtifactDocumentSchema>;

export const SearchTaskSchema = z.object({
  id: z.string(),
  query: z.string(),
  angle: z.string(),
  priority: z.number().min(0).max(1).default(0.5),
  providers: z.array(z.enum(["exa", "tavily", "firecrawl", "mock"])),
});

export type SearchTask = z.infer<typeof SearchTaskSchema>;

export const EvidenceQuoteSchema = z.object({
  sourceId: z.string(),
  quote: z.string(),
  url: z.string().optional(),
  locator: z.string().optional(),
});

export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;

export const SourceRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  provider: z.string(),
  sourceKind: SourceKindSchema,
  credibility: z.number().min(0).max(1),
  freshness: z.string().optional(),
  summary: z.string(),
  keyQuotes: z.array(z.string()),
  tags: z.array(z.string()),
});

export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const ClaimRecordSchema = z.object({
  id: z.string(),
  text: z.string(),
  claimKind: ClaimKindSchema,
  status: ClaimStatusSchema,
  confidence: z.number().min(0).max(1),
  sources: z.array(z.string()),
  opposes: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

export const ResearchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.created"), runId: z.string(), at: z.string() }),
  z.object({ type: z.literal("run.updated"), runId: z.string(), status: RunStatusSchema, at: z.string() }),
  z.object({
    type: z.literal("agent.started"),
    runId: z.string(),
    agent: AgentRoleSchema,
    taskId: z.string(),
    label: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("agent.finished"),
    runId: z.string(),
    agent: AgentRoleSchema,
    taskId: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("agent.message.delta"),
    runId: z.string(),
    agent: AgentRoleSchema,
    taskId: z.string(),
    text: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("tool.started"),
    runId: z.string(),
    tool: z.string(),
    taskId: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("tool.finished"),
    runId: z.string(),
    tool: z.string(),
    taskId: z.string(),
    ok: z.boolean(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("artifact.created"),
    runId: z.string(),
    artifact: ArtifactRefSchema,
    at: z.string(),
  }),
  z.object({
    type: z.literal("claim.challenged"),
    runId: z.string(),
    claimId: z.string(),
    questionId: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    at: z.string(),
  }),
  z.object({
    type: z.literal("insight.created"),
    runId: z.string(),
    insightId: z.string(),
    novelty: z.enum(["low", "medium", "high"]),
    at: z.string(),
  }),
  z.object({
    type: z.literal("run.finished"),
    runId: z.string(),
    reportPath: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("run.failed"),
    runId: z.string(),
    error: z.string(),
    at: z.string(),
  }),
]);

export type ResearchEvent = z.infer<typeof ResearchEventSchema>;

export const RunCreateRequestSchema = z.object({
  query: z.string().min(3),
  domain: z.string().optional(),
  maxSearchTasks: z.number().int().min(1).max(12).optional(),
});

export type RunCreateRequest = z.infer<typeof RunCreateRequestSchema>;

export const FeedbackRequestSchema = z.object({
  artifactId: z.string(),
  rating: z.enum(["up", "down"]),
  dimension: z.enum(["usefulness", "credibility", "correctness", "citation_support", "insight_value", "report_value"]),
  note: z.string().optional(),
});

export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export const DEFAULT_LIMITS = {
  maxConcurrentLlmCalls: 8,
  maxSearchAgents: 6,
  maxReaderAgents: 10,
  maxCritiqueAgents: 4,
  maxProviderRequestsPerProvider: 4,
} as const;

