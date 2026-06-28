import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type {
  ArtifactDocument,
  ArtifactKind,
  ArtifactRef,
  FeedbackRequest,
  ResearchEvent,
  ResearchRun,
} from "@fdr/schemas";

const RUN_SUBDIRS = ["sources", "claims", "questions", "critiques", "insights", "audits", "feedback"] as const;

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

export interface SourceReputationSignal {
  up: number;
  down: number;
  adjustment: number;
  matchedFeedback: number;
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      artifactRoot: root,
    };

    await writeFile(path.join(root, "run.json"), JSON.stringify({ ...run, domain: input.domain }, null, 2));
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
    await writeFile(path.join(this.runDir(run.id), "run.json"), JSON.stringify(updated, null, 2));
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
    const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as ResearchEvent);
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
    await writeFile(filePath, content);
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
    await appendFile(filePath, `\n## ${sectionTitle}\n\n${markdown.trim()}\n`);
  }

  async readArtifact(runId: string, artifactPath: string): Promise<ArtifactDocument | undefined> {
    const fullPath = path.join(this.runDir(runId), artifactPath);
    if (!(await exists(fullPath))) {
      return undefined;
    }
    const parsed = matter(await readFile(fullPath, "utf8"));
    const id = typeof parsed.data.id === "string" ? parsed.data.id : path.basename(artifactPath, ".md");
    const kind = typeof parsed.data.type === "string" ? (parsed.data.type as ArtifactKind) : "source";
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
    const artifacts = await this.listArtifacts(runId);
    const match = artifacts.find((artifact) => artifact.id === artifactId);
    return match ? this.readArtifact(runId, match.path) : undefined;
  }

  async listArtifacts(runId: string): Promise<ArtifactRef[]> {
    const root = this.runDir(runId);
    const files = (await walkFiles(root)).filter((file) => file.endsWith(".md"));
    const docs = await Promise.all(files.map((file) => this.readArtifact(runId, path.relative(root, file))));
    return docs
      .filter((doc): doc is ArtifactDocument => Boolean(doc))
      .map(({ body: _body, frontmatter: _frontmatter, ...ref }) => ref)
      .sort((a, b) => a.path.localeCompare(b.path));
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
    const id = `feedback-${Date.now()}`;
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

  async appendSourceReputationFeedback(input: {
    runId: string;
    feedback: FeedbackRequest;
    artifact?: ArtifactDocument;
  }): Promise<void> {
    await this.ensureBase();
    const filePath = path.join(this.globalDir, "source_reputation.md");
    const artifact = input.artifact;
    const url = typeof artifact?.frontmatter.url === "string" ? artifact.frontmatter.url : undefined;
    const title = artifact?.title ?? input.feedback.artifactId;
    const timestamp = nowIso();
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
    await appendFile(filePath, section);
  }

  async getSourceReputation(input: { url?: string; title: string }): Promise<SourceReputationSignal> {
    await this.ensureBase();
    const filePath = path.join(this.globalDir, "source_reputation.md");
    if (!(await exists(filePath))) {
      return { up: 0, down: 0, adjustment: 0, matchedFeedback: 0 };
    }

    const content = await readFile(filePath, "utf8");
    const targetUrl = normalizeReputationUrl(input.url);
    const targetTitle = normalizeTitle(input.title);
    let up = 0;
    let down = 0;

    for (const block of content.split(/\n## Feedback /g).slice(1)) {
      const blockUrl = normalizeReputationUrl(block.match(/^- URL:\s*(.+)$/m)?.[1]?.trim());
      const blockTitle = normalizeTitle(block.match(/^- Title:\s*(.+)$/m)?.[1]?.trim() ?? "");
      const rating = block.match(/^- Rating:\s*(up|down)$/m)?.[1];
      const urlMatches = Boolean(targetUrl && blockUrl && targetUrl === blockUrl);
      const titleMatches = Boolean(blockTitle && (targetTitle.includes(blockTitle) || blockTitle.includes(targetTitle)));
      if (!rating || (!urlMatches && !titleMatches)) {
        continue;
      }
      if (rating === "up") {
        up += 1;
      } else {
        down += 1;
      }
    }

    const matchedFeedback = up + down;
    const adjustment = matchedFeedback === 0 ? 0 : Number(clamp((up - down) * 0.04, -0.18, 0.18).toFixed(2));
    return { up, down, adjustment, matchedFeedback };
  }

  private async readLooseArtifact(filePath: string, root: string): Promise<ArtifactDocument | undefined> {
    if (!(await exists(filePath))) {
      return undefined;
    }
    const parsed = matter(await readFile(filePath, "utf8"));
    const relativePath = path.relative(root, filePath);
    const id = typeof parsed.data.id === "string" ? parsed.data.id : path.basename(filePath, ".md");
    const kind = typeof parsed.data.type === "string" ? (parsed.data.type as ArtifactKind) : "source";
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
