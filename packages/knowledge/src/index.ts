import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type {
  ArtifactDocument,
  ArtifactKind,
  ArtifactRef,
  FeedbackRequest,
  ResearchRun,
} from "@fdr/schemas";
import { ResearchEventSchema, type ResearchEvent } from "@fdr/schemas";

const RUN_SUBDIRS = [
  "sources",
  "claims",
  "questions",
  "critiques",
  "contradictions",
  "insights",
  "audits",
  "memory",
  "feedback",
] as const;

const ARTIFACT_KINDS = new Set<ArtifactKind>([
  "user_input",
  "plan",
  "blackboard",
  "source",
  "claim",
  "question",
  "critique",
  "contradiction",
  "ledger",
  "memory",
  "insight",
  "audit",
  "report",
  "feedback",
]);

export interface MarkdownStoreOptions {
  dataDir: string;
}

export interface WriteArtifactInput {
  runId: string;
  kind: ArtifactKind;
  id: string;
  title: string;
  collection?: (typeof RUN_SUBDIRS)[number];
  filename?: string;
  frontmatter?: Record<string, unknown>;
  body: string;
}

export interface MemoryBundle {
  global: ArtifactDocument[];
  domain: ArtifactDocument[];
}

export interface ArtifactIndexEntry extends ArtifactRef {
  frontmatter: Record<string, unknown>;
}

export interface ArtifactIndex {
  all: ArtifactIndexEntry[];
  byId: Map<string, ArtifactIndexEntry>;
  byKind: Map<ArtifactKind, ArtifactIndexEntry[]>;
  byTag: Map<string, ArtifactIndexEntry[]>;
  byFrontmatterValue: Map<string, ArtifactIndexEntry[]>;
}

export interface SourceReputationSignal {
  up: number;
  down: number;
  adjustment: number;
  matchedFeedback: number;
  trustedMatches: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeId(value: string): string {
  const slug = slugify(value);
  return slug.length > 0 ? slug : randomUUID();
}

function extractTitle(body: string, fallback: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback;
}

function parseArtifactKind(value: unknown, fallback: ArtifactKind): ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.has(value as ArtifactKind) ? (value as ArtifactKind) : fallback;
}

function normalizeReputationUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return value.toLowerCase().split("?")[0].replace(/\/$/, "");
  }
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

function reputationTargetMatches(input: {
  targetUrl?: string;
  targetTitle: string;
  candidateUrl?: string;
  candidateTitle?: string;
  text?: string;
}): boolean {
  const candidateTitle = normalizeTitle(input.candidateTitle ?? "");
  const normalizedText = normalizeTitle(input.text ?? "");
  const urlMatches = Boolean(input.targetUrl && input.candidateUrl && input.targetUrl === input.candidateUrl);
  const titleMatches = Boolean(
    candidateTitle.length >= 8 &&
      (input.targetTitle.includes(candidateTitle) || candidateTitle.includes(input.targetTitle)),
  );
  const textMatches = Boolean(
    input.targetTitle.length >= 8 && normalizedText.length >= 8 && normalizedText.includes(input.targetTitle),
  );
  const urlTextMatches = Boolean(input.targetUrl && input.text && normalizeReputationUrl(input.text) === input.targetUrl);
  return urlMatches || titleMatches || textMatches || urlTextMatches;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cleanFrontmatter(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => {
        if (Array.isArray(entryValue)) {
          return [key, entryValue.filter((item) => item !== undefined)];
        }
        if (entryValue && typeof entryValue === "object") {
          return [key, cleanFrontmatter(entryValue as Record<string, unknown>)];
        }
        return [key, entryValue];
      }),
  );
}

function parseResearchEventLine(line: string): ResearchEvent | undefined {
  try {
    const parsed = JSON.parse(line);
    return ResearchEventSchema.safeParse(parsed).success ? (parsed as ResearchEvent) : undefined;
  } catch {
    return undefined;
  }
}

function addToIndexMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key) ?? [];
  existing.push(value);
  map.set(key, existing);
}

function frontmatterValueKeys(frontmatter: Record<string, unknown>): string[] {
  return Object.entries(frontmatter).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string | number | boolean => ["string", "number", "boolean"].includes(typeof item))
        .map((item) => `${key}:${String(item)}`);
    }
    if (["string", "number", "boolean"].includes(typeof value)) {
      return [`${key}:${String(value)}`];
    }
    return [];
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
}

async function appendFileAtomic(filePath: string, content: string): Promise<void> {
  const existing = (await exists(filePath)) ? await readFile(filePath, "utf8") : "";
  await writeFileAtomic(filePath, `${existing}${content}`);
}

function resolveInsideRoot(root: string, unsafePath: string): string | undefined {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, unsafePath);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return undefined;
  }
  return resolved;
}

async function walkFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}

export class MarkdownStore {
  readonly dataDir: string;
  readonly globalDir: string;
  readonly domainsDir: string;
  readonly runsDir: string;

  constructor(options: MarkdownStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.globalDir = path.join(this.dataDir, "global");
    this.domainsDir = path.join(this.dataDir, "domains");
    this.runsDir = path.join(this.dataDir, "runs");
  }

  async ensureBase(): Promise<void> {
    await mkdir(this.globalDir, { recursive: true });
    await mkdir(this.domainsDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
  }

  runDir(runId: string): string {
    return path.join(this.runsDir, safeId(runId));
  }

  async createRun(input: { query: string; domain?: string }): Promise<ResearchRun> {
    await this.ensureBase();
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeId(input.query).slice(0, 44)}`;
    const root = this.runDir(runId);
    await mkdir(root, { recursive: true });
    await Promise.all(RUN_SUBDIRS.map((dir) => mkdir(path.join(root, dir), { recursive: true })));

    const timestamp = nowIso();
    const run: ResearchRun = {
      id: runId,
      query: input.query,
      domain: input.domain,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      artifactRoot: root,
    };

    await writeFileAtomic(path.join(root, "run.json"), JSON.stringify(run, null, 2));
    await this.writeArtifact({
      runId,
      kind: "user_input",
      id: "user-input",
      title: "User Input",
      filename: "00_user_input.md",
      frontmatter: {
        id: "user-input",
        type: "user_input",
        domain: input.domain,
        created_at: timestamp,
      },
      body: `# User Input\n\n${input.query.trim()}\n`,
    });
    await this.writeArtifact({
      runId,
      kind: "blackboard",
      id: "blackboard",
      title: "Research Blackboard",
      filename: "02_blackboard.md",
      frontmatter: {
        id: "blackboard",
        type: "blackboard",
        created_at: timestamp,
      },
      body: "# Research Blackboard\n\n## Current State\n\nRun initialized.\n",
    });
    return run;
  }

  async updateRun(run: ResearchRun): Promise<ResearchRun> {
    const updated = { ...run, updatedAt: nowIso() };
    await writeFileAtomic(path.join(this.runDir(run.id), "run.json"), JSON.stringify(updated, null, 2));
    return updated;
  }

  async readRun(runId: string): Promise<ResearchRun | undefined> {
    const filePath = path.join(this.runDir(runId), "run.json");
    if (!(await exists(filePath))) {
      return undefined;
    }
    return JSON.parse(await readFile(filePath, "utf8")) as ResearchRun;
  }

  async listRuns(): Promise<ResearchRun[]> {
    await this.ensureBase();
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => this.readRun(entry.name)),
    );
    return runs
      .filter((run): run is ResearchRun => Boolean(run))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendEvent(runId: string, event: ResearchEvent): Promise<void> {
    await appendFile(path.join(this.runDir(runId), "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  async readEvents(runId: string): Promise<ResearchEvent[]> {
    const filePath = path.join(this.runDir(runId), "events.jsonl");
    if (!(await exists(filePath))) {
      return [];
    }
    return (await readFile(filePath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseResearchEventLine)
      .filter((event): event is ResearchEvent => Boolean(event));
  }

  artifactPath(input: WriteArtifactInput): string {
    const fileName = input.filename ?? `${input.id}.md`;
    if (input.collection) {
      return path.join(this.runDir(input.runId), input.collection, fileName);
    }
    return path.join(this.runDir(input.runId), fileName);
  }

  async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef> {
    const timestamp = nowIso();
    const filePath = this.artifactPath(input);
    await mkdir(path.dirname(filePath), { recursive: true });
    const frontmatter = cleanFrontmatter({
      id: input.id,
      type: input.kind,
      title: input.title,
      created_at: timestamp,
      updated_at: timestamp,
      ...(input.frontmatter ?? {}),
    });
    const content = matter.stringify(input.body.trimEnd() + "\n", frontmatter);
    const frontmatterRecord = frontmatter as Record<string, unknown>;
    await writeFileAtomic(filePath, content);
    return {
      id: input.id,
      kind: input.kind,
      title: input.title,
      path: path.relative(this.runDir(input.runId), filePath),
      createdAt: String(frontmatter.created_at),
      updatedAt: String(frontmatter.updated_at),
      tags: Array.isArray(frontmatterRecord.tags) ? (frontmatterRecord.tags as string[]) : [],
    };
  }

  async appendBlackboard(runId: string, sectionTitle: string, markdown: string): Promise<void> {
    const filePath = path.join(this.runDir(runId), "02_blackboard.md");
    const parsed = matter(await readFile(filePath, "utf8"));
    const frontmatter = cleanFrontmatter({
      ...parsed.data,
      updated_at: nowIso(),
    });
    const section = `\n## ${sectionTitle}\n\n${markdown.trim()}\n`;
    await writeFileAtomic(filePath, matter.stringify(`${parsed.content.trimEnd()}${section}`, frontmatter));
  }

  async readArtifact(runId: string, artifactPath: string): Promise<ArtifactDocument | undefined> {
    if (!artifactPath.endsWith(".md")) {
      return undefined;
    }
    const root = this.runDir(runId);
    const fullPath = resolveInsideRoot(root, artifactPath);
    if (!fullPath) {
      return undefined;
    }
    if (!(await exists(fullPath))) {
      return undefined;
    }
    const parsed = matter(await readFile(fullPath, "utf8"));
    const id = typeof parsed.data.id === "string" ? parsed.data.id : path.basename(artifactPath, ".md");
    const kind = parseArtifactKind(parsed.data.type, "source");
    const title = typeof parsed.data.title === "string" ? parsed.data.title : extractTitle(parsed.content, id);
    return {
      id,
      kind,
      title,
      path: artifactPath,
      createdAt: typeof parsed.data.created_at === "string" ? parsed.data.created_at : undefined,
      updatedAt: typeof parsed.data.updated_at === "string" ? parsed.data.updated_at : undefined,
      tags: Array.isArray(parsed.data.tags) ? (parsed.data.tags as string[]) : [],
      frontmatter: parsed.data,
      body: parsed.content.trim(),
    };
  }

  async readArtifactById(runId: string, artifactId: string): Promise<ArtifactDocument | undefined> {
    const index = await this.buildArtifactIndex(runId);
    const match = index.byId.get(artifactId);
    return match ? this.readArtifact(runId, match.path) : undefined;
  }

  async listArtifacts(runId: string): Promise<ArtifactRef[]> {
    const index = await this.buildArtifactIndex(runId);
    return index.all.map(({ frontmatter: _frontmatter, ...ref }) => ref);
  }

  async buildArtifactIndex(runId: string): Promise<ArtifactIndex> {
    const root = this.runDir(runId);
    const files = (await walkFiles(root)).filter((file) => file.endsWith(".md"));
    const docs = await Promise.all(files.map((file) => this.readArtifact(runId, path.relative(root, file))));
    const all = docs
      .filter((doc): doc is ArtifactDocument => Boolean(doc))
      .map(({ body: _body, ...entry }) => entry)
      .sort((a, b) => a.path.localeCompare(b.path));
    const byId = new Map<string, ArtifactIndexEntry>();
    const byKind = new Map<ArtifactKind, ArtifactIndexEntry[]>();
    const byTag = new Map<string, ArtifactIndexEntry[]>();
    const byFrontmatterValue = new Map<string, ArtifactIndexEntry[]>();

    for (const entry of all) {
      byId.set(entry.id, entry);
      const kindEntries = byKind.get(entry.kind) ?? [];
      kindEntries.push(entry);
      byKind.set(entry.kind, kindEntries);
      for (const tag of entry.tags) {
        addToIndexMap(byTag, tag, entry);
      }
      for (const key of frontmatterValueKeys(entry.frontmatter)) {
        addToIndexMap(byFrontmatterValue, key, entry);
      }
    }

    return { all, byId, byKind, byTag, byFrontmatterValue };
  }

  async loadMemory(domain?: string): Promise<MemoryBundle> {
    const globalFiles = (await walkFiles(this.globalDir)).filter((file) => file.endsWith(".md"));
    const domainRoot = domain ? path.join(this.domainsDir, safeId(domain)) : "";
    const domainFiles = domainRoot ? (await walkFiles(domainRoot)).filter((file) => file.endsWith(".md")) : [];
    const global = await Promise.all(globalFiles.map((file) => this.readLooseArtifact(file, this.globalDir)));
    const domainDocs = await Promise.all(domainFiles.map((file) => this.readLooseArtifact(file, domainRoot)));
    return {
      global: global.filter((doc): doc is ArtifactDocument => Boolean(doc)),
      domain: domainDocs.filter((doc): doc is ArtifactDocument => Boolean(doc)),
    };
  }

  async appendFeedback(runId: string, feedback: FeedbackRequest): Promise<ArtifactRef> {
    const id = `feedback-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return this.writeArtifact({
      runId,
      kind: "feedback",
      id,
      collection: "feedback",
      title: `Feedback on ${feedback.artifactId}`,
      frontmatter: {
        id,
        type: "feedback",
        artifact_id: feedback.artifactId,
        rating: feedback.rating,
        dimension: feedback.dimension,
      },
      body: `# Feedback on ${feedback.artifactId}\n\n- Rating: ${feedback.rating}\n- Dimension: ${feedback.dimension}\n\n${feedback.note ?? ""}\n`,
    });
  }

  async appendFeedbackToArtifact(runId: string, feedback: FeedbackRequest, feedbackArtifact: ArtifactRef): Promise<ArtifactRef | undefined> {
    const target = (await this.listArtifacts(runId)).find((artifact) => artifact.id === feedback.artifactId);
    if (!target) {
      return undefined;
    }

    const filePath = path.join(this.runDir(runId), target.path);
    const parsed = matter(await readFile(filePath, "utf8"));
    const timestamp = nowIso();
    const priorCount = typeof parsed.data.feedback_count === "number" ? parsed.data.feedback_count : 0;
    const frontmatter = cleanFrontmatter({
      ...parsed.data,
      updated_at: timestamp,
      feedback_count: priorCount + 1,
      latest_feedback: feedbackArtifact.id,
    });
    const feedbackSnippet = [
      "",
      "## Human Feedback",
      "",
      `- Feedback artifact: ${feedbackArtifact.id}`,
      `- Rating: ${feedback.rating}`,
      `- Dimension: ${feedback.dimension}`,
      feedback.note ? `- Note: ${feedback.note}` : undefined,
      `- Recorded at: ${timestamp}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    await writeFileAtomic(filePath, matter.stringify(`${parsed.content.trimEnd()}\n${feedbackSnippet}\n`, frontmatter));
    return this.readArtifact(runId, target.path);
  }

  async appendSourceReputationFeedback(input: {
    runId: string;
    feedback: FeedbackRequest;
    artifact?: ArtifactDocument;
  }): Promise<void> {
    await this.ensureBase();
    const artifact = input.artifact;
    if (artifact?.kind !== "source") {
      return;
    }
    const filePath = path.join(this.globalDir, "source_reputation.md");
    const url = typeof artifact?.frontmatter.url === "string" ? artifact.frontmatter.url : undefined;
    const title = artifact?.title ?? input.feedback.artifactId;
    const timestamp = nowIso();
    const existing = (await exists(filePath))
      ? matter(await readFile(filePath, "utf8"))
      : {
          data: { type: "source_reputation", title: "Source Reputation" },
          content: ["# Source Reputation", "", "Human source feedback is appended here after source reviews."].join("\n"),
        };
    const section = [
      "",
      `## Feedback ${timestamp}`,
      "",
      `- Run: ${input.runId}`,
      `- Artifact: ${input.feedback.artifactId}`,
      `- Title: ${title}`,
      url ? `- URL: ${url}` : undefined,
      `- Rating: ${input.feedback.rating}`,
      `- Dimension: ${input.feedback.dimension}`,
      input.feedback.note ? `- Note: ${input.feedback.note}` : undefined,
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const frontmatter = cleanFrontmatter({
      ...existing.data,
      type: existing.data.type ?? "source_reputation",
      title: existing.data.title ?? "Source Reputation",
      updated_at: timestamp,
    });
    await writeFileAtomic(filePath, matter.stringify(`${existing.content.trimEnd()}${section}\n`, frontmatter));
  }

  async appendDomainTrustedSourceFeedback(input: {
    runId: string;
    domain?: string;
    feedback: FeedbackRequest;
    artifact?: ArtifactDocument;
  }): Promise<void> {
    await this.ensureBase();
    if (!input.domain || input.feedback.rating !== "up" || input.artifact?.kind !== "source") {
      return;
    }
    const domainDir = path.join(this.domainsDir, safeId(input.domain));
    await mkdir(domainDir, { recursive: true });
    const filePath = path.join(domainDir, "trusted_sources.md");
    const url = typeof input.artifact.frontmatter.url === "string" ? input.artifact.frontmatter.url : undefined;
    const timestamp = nowIso();
    const existing = (await exists(filePath))
      ? matter(await readFile(filePath, "utf8"))
      : {
          data: { type: "trusted_sources", title: "Trusted Sources" },
          content: ["# Trusted Sources", "", "Domain-specific trusted source feedback is appended here."].join("\n"),
        };
    const targetUrl = normalizeReputationUrl(url);
    const targetTitle = normalizeTitle(input.artifact.title);
    if (
      existing.content.split(/\n(?=##\s+Trusted Source )/g).some((block) =>
        reputationTargetMatches({
          targetUrl,
          targetTitle,
          candidateUrl: normalizeReputationUrl(block.match(/^- URL:\s*(.+)$/m)?.[1]?.trim()),
          candidateTitle: block.match(/^- Title:\s*(.+)$/m)?.[1]?.trim(),
          text: block,
        }),
      )
    ) {
      return;
    }
    const section = [
      "",
      `## Trusted Source ${timestamp}`,
      "",
      `- Run: ${input.runId}`,
      `- Artifact: ${input.feedback.artifactId}`,
      `- Title: ${input.artifact.title}`,
      url ? `- URL: ${url}` : undefined,
      `- Dimension: ${input.feedback.dimension}`,
      input.feedback.note ? `- Note: ${input.feedback.note}` : undefined,
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const frontmatter = cleanFrontmatter({
      ...existing.data,
      type: existing.data.type ?? "trusted_sources",
      title: existing.data.title ?? "Trusted Sources",
      updated_at: timestamp,
    });
    await writeFileAtomic(filePath, matter.stringify(`${existing.content.trimEnd()}${section}\n`, frontmatter));
  }

  async appendUserFeedbackMemory(input: {
    runId: string;
    feedback: FeedbackRequest;
    artifact: ArtifactDocument;
  }): Promise<void> {
    await this.ensureBase();
    if (input.artifact.kind === "source") {
      return;
    }
    const filePath = path.join(this.globalDir, "user_preferences.md");
    const timestamp = nowIso();
    const existing = (await exists(filePath))
      ? matter(await readFile(filePath, "utf8"))
      : {
          data: { type: "user_preferences", title: "User Preferences" },
          content: ["# User Preferences", "", "Reusable human feedback from prior research runs is appended here."].join("\n"),
        };
    const guidance =
      input.feedback.rating === "up"
        ? "Prefer similar handling in future runs."
        : "Avoid or scrutinize similar handling in future runs.";
    const section = [
      "",
      `## Feedback ${timestamp}`,
      "",
      `- Run: ${input.runId}`,
      `- Artifact: ${input.feedback.artifactId}`,
      `- Artifact kind: ${input.artifact.kind}`,
      `- Title: ${input.artifact.title}`,
      `- Rating: ${input.feedback.rating}`,
      `- Dimension: ${input.feedback.dimension}`,
      input.feedback.note ? `- Note: ${input.feedback.note}` : undefined,
      `- Guidance: ${guidance}`,
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const frontmatter = cleanFrontmatter({
      ...existing.data,
      type: existing.data.type ?? "user_preferences",
      title: existing.data.title ?? "User Preferences",
      updated_at: timestamp,
    });
    await writeFileAtomic(filePath, matter.stringify(`${existing.content.trimEnd()}${section}\n`, frontmatter));
  }

  async appendRecurringLesson(input: {
    runId: string;
    title: string;
    domain?: string;
    lesson: string;
    evidence: string[];
    tags: string[];
  }): Promise<void> {
    await this.ensureBase();
    const filePath = path.join(this.globalDir, "recurring_lessons.md");
    const timestamp = nowIso();
    const existing = (await exists(filePath))
      ? matter(await readFile(filePath, "utf8"))
      : {
          data: { type: "recurring_lessons" },
          content: ["# Recurring Lessons", "", "Reusable research lessons are appended here after runs complete."].join("\n"),
        };
    const section = [
      "",
      `## ${input.title}`,
      "",
      `- Run: ${input.runId}`,
      input.domain ? `- Domain: ${input.domain}` : undefined,
      `- Tags: ${input.tags.join(", ")}`,
      "",
      input.lesson,
      "",
      "### Evidence",
      "",
      ...input.evidence.map((item) => `- ${item}`),
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const frontmatter = cleanFrontmatter({
      ...existing.data,
      type: existing.data.type ?? "recurring_lessons",
      updated_at: timestamp,
    });
    await writeFileAtomic(filePath, matter.stringify(`${existing.content.trimEnd()}${section}\n`, frontmatter));
  }

  async getSourceReputation(input: { url?: string; title: string; domain?: string }): Promise<SourceReputationSignal> {
    await this.ensureBase();
    const filePath = path.join(this.globalDir, "source_reputation.md");
    const targetUrl = normalizeReputationUrl(input.url);
    const targetTitle = normalizeTitle(input.title);
    let up = 0;
    let down = 0;
    let trustedMatches = 0;

    if (await exists(filePath)) {
      const content = await readFile(filePath, "utf8");
      for (const block of content.split(/\n## Feedback /g).slice(1)) {
        const blockUrl = normalizeReputationUrl(block.match(/^- URL:\s*(.+)$/m)?.[1]?.trim());
        const blockTitle = block.match(/^- Title:\s*(.+)$/m)?.[1]?.trim();
        const rating = block.match(/^- Rating:\s*(up|down)$/m)?.[1];
        if (
          !rating ||
          !reputationTargetMatches({
            targetUrl,
            targetTitle,
            candidateUrl: blockUrl,
            candidateTitle: blockTitle,
          })
        ) {
          continue;
        }
        if (rating === "up") {
          up += 1;
        } else {
          down += 1;
        }
      }
    }

    if (input.domain) {
      const trustedPath = path.join(this.domainsDir, safeId(input.domain), "trusted_sources.md");
      if (await exists(trustedPath)) {
        const trustedContent = await readFile(trustedPath, "utf8");
        for (const line of trustedContent.split("\n")) {
          const url = line.match(/https?:\/\/[^\s)>\]]+/)?.[0];
          if (
            reputationTargetMatches({
              targetUrl,
              targetTitle,
              candidateUrl: normalizeReputationUrl(url),
              text: line,
            })
          ) {
            trustedMatches += 1;
          }
        }
      }
    }

    const matchedFeedback = up + down;
    const feedbackAdjustment = matchedFeedback === 0 ? 0 : (up - down) * 0.04;
    const trustedAdjustment = trustedMatches > 0 ? 0.08 : 0;
    const adjustment = Number(clamp(feedbackAdjustment + trustedAdjustment, -0.18, 0.22).toFixed(2));
    return { up, down, adjustment, matchedFeedback, trustedMatches };
  }

  private async readLooseArtifact(filePath: string, root: string): Promise<ArtifactDocument | undefined> {
    if (!(await exists(filePath))) {
      return undefined;
    }
    const parsed = matter(await readFile(filePath, "utf8"));
    const relativePath = path.relative(root, filePath);
    const id = typeof parsed.data.id === "string" ? parsed.data.id : path.basename(filePath, ".md");
    const kind = parseArtifactKind(parsed.data.type, "memory");
    const title = typeof parsed.data.title === "string" ? parsed.data.title : extractTitle(parsed.content, id);
    return {
      id,
      kind,
      title,
      path: relativePath,
      createdAt: typeof parsed.data.created_at === "string" ? parsed.data.created_at : undefined,
      updatedAt: typeof parsed.data.updated_at === "string" ? parsed.data.updated_at : undefined,
      tags: Array.isArray(parsed.data.tags) ? (parsed.data.tags as string[]) : [],
      frontmatter: parsed.data,
      body: parsed.content.trim(),
    };
  }
}

export function getDefaultDataDir(): string {
  return process.env.FDR_DATA_DIR ?? path.resolve(process.env.INIT_CWD ?? process.cwd(), "knowledge");
}
