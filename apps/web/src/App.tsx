import type { ArtifactDocument, ArtifactKind, ArtifactRef, FeedbackRequest, ResearchEvent, ResearchRun } from "@fdr/schemas";
import {
  Activity,
  BadgeCheck,
  BookOpen,
  Brain,
  CheckCircle2,
  CircleAlert,
  FileText,
  Flame,
  Gauge,
  History,
  Lightbulb,
  MessageSquareWarning,
  Moon,
  PauseCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";
import { bodyRefs, frontmatterRefs } from "./artifactRefs";
import { MarkdownView } from "./MarkdownView";

type ArtifactTab = "report" | "ledger" | "check" | "claim" | "source" | "question" | "insight" | "audit" | "memory";
type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "closed";
type ThemeMode = "light" | "dark";

interface HealthState {
  ok: boolean;
  dataDir: string;
  searchProviders: string[];
  fetchProvider: string;
  llmRuntime: {
    mode: "fallback" | "pi";
    provider?: string;
    model?: string;
  };
  researchLimits: {
    maxSearchAgents: number;
    maxReaderAgents: number;
    maxCritiqueAgents: number;
  };
}

const SAMPLE_QUERY =
  "Research the 2026 AI coding agent market and identify which startups or product strategies have the strongest enterprise opportunity.";
const THEME_STORAGE_KEY = "fdr-theme";

const tabLabels: Record<ArtifactTab, string> = {
  report: "Report",
  ledger: "Ledger",
  check: "Cross-check",
  claim: "Claims",
  source: "Sources",
  question: "Questions",
  insight: "Insights",
  audit: "Audit",
  memory: "Memory",
};

const tabKinds: Record<ArtifactTab, ArtifactKind[]> = {
  report: ["report"],
  ledger: ["ledger"],
  check: ["contradiction"],
  claim: ["claim"],
  source: ["source"],
  question: ["question", "critique"],
  insight: ["insight"],
  audit: ["audit"],
  memory: ["memory", "feedback"],
};

const feedbackDimensionLabels: Record<FeedbackRequest["dimension"], string> = {
  usefulness: "Usefulness",
  credibility: "Credibility",
  correctness: "Correctness",
  citation_support: "Citation support",
  insight_value: "Insight value",
  report_value: "Report value",
};

function cn(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }
  const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function formatLlmRuntime(health?: HealthState): string {
  if (!health) {
    return "llm";
  }
  const { llmRuntime } = health;
  return llmRuntime.mode === "pi" && llmRuntime.provider && llmRuntime.model
    ? `${llmRuntime.provider}/${llmRuntime.model}`
    : "fallback";
}

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== "number") {
    return "";
  }
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function streamStatusLabel(state: StreamState): string {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Stream live";
    case "reconnecting":
      return "Reconnecting";
    case "closed":
      return "Stream closed";
    case "idle":
      return "No stream";
  }
}

function defaultFeedbackDimension(kind: ArtifactKind): FeedbackRequest["dimension"] {
  if (kind === "source") {
    return "credibility";
  }
  if (kind === "claim") {
    return "correctness";
  }
  if (kind === "audit") {
    return "citation_support";
  }
  if (kind === "insight") {
    return "insight_value";
  }
  if (kind === "report") {
    return "report_value";
  }
  return "usefulness";
}

function compactBody(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}...`;
}

function artifactTime(artifact: ArtifactRef): number {
  return Date.parse(artifact.updatedAt ?? artifact.createdAt ?? "") || 0;
}

function eventKey(event: ResearchEvent): string {
  switch (event.type) {
    case "run.updated":
      return `${event.type}:${event.runId}:${event.status}:${event.at}`;
    case "agent.started":
      return `${event.type}:${event.runId}:${event.taskId}:${event.label}:${event.at}`;
    case "agent.finished":
      return `${event.type}:${event.runId}:${event.taskId}:${event.durationMs ?? ""}:${event.at}`;
    case "agent.message.delta":
      return `${event.type}:${event.runId}:${event.taskId}:${event.text}:${event.at}`;
    case "tool.started":
    case "tool.finished":
      return `${event.type}:${event.runId}:${event.taskId}:${event.tool}:${event.at}`;
    case "artifact.created":
    case "artifact.updated":
      return `${event.type}:${event.runId}:${event.artifact.id}:${event.at}`;
    case "claim.challenged":
      return `${event.type}:${event.runId}:${event.claimId}:${event.questionId}:${event.at}`;
    case "insight.created":
      return `${event.type}:${event.runId}:${event.insightId}:${event.at}`;
    case "deep_dive.started":
    case "deep_dive.finished":
      return `${event.type}:${event.runId}:${event.questionId}:${event.at}`;
    case "continuation.started":
      return `${event.type}:${event.runId}:${event.questionId ?? ""}:${event.prompt}:${event.at}`;
    case "continuation.finished":
    case "run.finished":
      return `${event.type}:${event.runId}:${event.reportPath}:${event.at}`;
    case "run.failed":
      return `${event.type}:${event.runId}:${event.error}:${event.at}`;
    case "run.created":
      return `${event.type}:${event.runId}:${event.at}`;
  }
}

function mergeEvents(current: ResearchEvent[], incoming: ResearchEvent[]): ResearchEvent[] {
  const seen = new Set<string>();
  return [...current, ...incoming]
    .filter((event) => {
      const key = eventKey(event);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-300);
}

function formatTime(value?: string): string {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function eventLabel(event: ResearchEvent): string {
  switch (event.type) {
    case "run.created":
      return "Run created";
    case "run.updated":
      return `Run ${event.status}`;
    case "agent.started":
      return `${event.agent} started`;
    case "agent.finished":
      return `${event.agent} finished`;
    case "agent.message.delta":
      return `${event.agent} note`;
    case "tool.started":
      return `${event.tool} started`;
    case "tool.finished":
      return `${event.tool} ${event.ok ? "finished" : "failed"}`;
    case "artifact.created":
      return `${event.artifact.kind} created`;
    case "artifact.updated":
      return `${event.artifact.kind} updated`;
    case "claim.challenged":
      return `${event.claimId} challenged`;
    case "insight.created":
      return `${event.insightId} created`;
    case "deep_dive.started":
      return "Auto deep dive started";
    case "deep_dive.finished":
      return "Auto deep dive finished";
    case "run.finished":
      return "Run finished";
    case "continuation.started":
      return "Continuation started";
    case "continuation.finished":
      return "Continuation finished";
    case "run.failed":
      return "Run failed";
  }
}

function eventIcon(event: ResearchEvent) {
  if (event.type === "run.failed" || (event.type === "tool.finished" && !event.ok)) {
    return <CircleAlert size={15} />;
  }
  if (event.type === "insight.created") {
    return <Lightbulb size={15} />;
  }
  if (event.type.startsWith("continuation") || event.type.startsWith("deep_dive")) {
    return <Sparkles size={15} />;
  }
  if (event.type === "claim.challenged") {
    return <MessageSquareWarning size={15} />;
  }
  if (event.type === "artifact.created" || event.type === "artifact.updated") {
    return <FileText size={15} />;
  }
  if (event.type.includes("agent")) {
    return <Brain size={15} />;
  }
  if (event.type.includes("tool")) {
    return <Activity size={15} />;
  }
  return <CheckCircle2 size={15} />;
}

function eventDetail(event: ResearchEvent): string {
  switch (event.type) {
    case "agent.finished":
      return [event.usedPi ? event.model ?? "Pi runtime" : event.usedPi === false ? "fallback runtime" : "", formatDuration(event.durationMs)]
        .filter(Boolean)
        .join(" - ");
    case "agent.message.delta":
      return event.text;
    case "artifact.created":
    case "artifact.updated":
      return event.artifact.title;
    case "claim.challenged":
      return `${event.questionId} (${event.severity})`;
    case "tool.finished":
      return [event.ok ? "" : event.error ?? "Tool call failed", formatDuration(event.durationMs)].filter(Boolean).join(" - ");
    case "deep_dive.started":
      return event.targetClaimId ? `${event.questionId} -> ${event.targetClaimId}: ${event.prompt}` : `${event.questionId}: ${event.prompt}`;
    case "deep_dive.finished":
      return `${event.critiqueId}: ${event.sourceCount} sources, ${event.claimCount} claims`;
    case "run.failed":
      return event.error;
    case "run.finished":
      return event.reportPath;
    case "continuation.started":
      return event.questionId ? `${event.questionId}: ${event.prompt}` : event.prompt;
    case "continuation.finished":
      return event.reportPath;
    default:
      return "";
  }
}

function isTerminalRunEvent(event: ResearchEvent): boolean {
  return (
    event.type === "run.finished" ||
    event.type === "run.failed" ||
    (event.type === "run.updated" && ["finished", "failed", "cancelled"].includes(event.status))
  );
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [query, setQuery] = useState(SAMPLE_QUERY);
  const [domain, setDomain] = useState("ai-coding-agents");
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const [artifactDocsByPath, setArtifactDocsByPath] = useState<Record<string, ArtifactDocument>>({});
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactDocument>();
  const [memoryDocs, setMemoryDocs] = useState<{ global: ArtifactDocument[]; domain: ArtifactDocument[] }>({
    global: [],
    domain: [],
  });
  const [activeTab, setActiveTab] = useState<ArtifactTab>("report");
  const [health, setHealth] = useState<HealthState>();
  const [isStarting, setIsStarting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [feedbackInFlight, setFeedbackInFlight] = useState<FeedbackRequest["rating"]>();
  const [error, setError] = useState<string>();
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [feedbackDimension, setFeedbackDimension] = useState<FeedbackRequest["dimension"]>("usefulness");
  const [feedbackNote, setFeedbackNote] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const selectedArtifactRef = useRef<ArtifactDocument | undefined>(undefined);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId), [runs, selectedRunId]);
  const effectiveDomain = useMemo(() => (selectedRun?.domain ?? domain.trim()) || undefined, [domain, selectedRun?.domain]);

  const runTelemetry = useMemo(() => {
    const finishedAgents = events.filter((event): event is ResearchEvent & { type: "agent.finished" } => event.type === "agent.finished");
    const finishedTools = events.filter((event): event is ResearchEvent & { type: "tool.finished" } => event.type === "tool.finished");
    const measuredAgentDurations = finishedAgents
      .map((event) => event.durationMs)
      .filter((duration): duration is number => typeof duration === "number");
    const runtimeMs = selectedRun
      ? Math.max(0, Date.parse(selectedRun.updatedAt) - Date.parse(selectedRun.createdAt))
      : undefined;
    const averageAgentDurationMs =
      measuredAgentDurations.length > 0
        ? Math.round(measuredAgentDurations.reduce((total, duration) => total + duration, 0) / measuredAgentDurations.length)
        : undefined;

    return {
      runtimeMs,
      finishedAgentCount: finishedAgents.length,
      averageAgentDurationMs,
      toolFailureCount: finishedTools.filter((event) => !event.ok).length,
      fallbackAgentCount: finishedAgents.filter((event) => event.usedPi === false).length,
    };
  }, [events, selectedRun]);

  const artifactCounts = useMemo(() => {
    return Object.fromEntries(
      Object.entries(tabKinds).map(([tab, kinds]) => [tab, artifacts.filter((artifact) => kinds.includes(artifact.kind)).length]),
    ) as Record<ArtifactTab, number>;
  }, [artifacts]);

  const visibleArtifacts = useMemo(() => {
    const kinds = tabKinds[activeTab];
    return artifacts.filter((artifact) => kinds.includes(artifact.kind));
  }, [activeTab, artifacts]);

  const artifactById = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);

  const linkedArtifacts = useMemo(() => {
    if (!selectedArtifact) {
      return [];
    }
    const directIds = new Set([...frontmatterRefs(selectedArtifact.frontmatter), ...bodyRefs(selectedArtifact.body)]);
    const reverseIds = new Set(
      Object.values(artifactDocsByPath)
        .filter(
          (doc) =>
            doc.id !== selectedArtifact.id &&
            (frontmatterRefs(doc.frontmatter).includes(selectedArtifact.id) || bodyRefs(doc.body).includes(selectedArtifact.id)),
        )
        .map((doc) => doc.id),
    );
    const ids = new Set([...directIds, ...reverseIds]);
    return artifacts.filter((artifact) => ids.has(artifact.id));
  }, [artifactDocsByPath, artifacts, selectedArtifact]);

  const latestReport = useMemo(() => {
    return artifacts
      .filter((artifact) => artifact.kind === "report")
      .sort((a, b) => artifactTime(b) - artifactTime(a) || b.path.localeCompare(a.path))[0];
  }, [artifacts]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const refreshRuns = useCallback(async () => {
    const payload = await api.listRuns();
    setRuns(payload.runs);
    if (!selectedRunId && payload.runs[0]) {
      setSelectedRunId(payload.runs[0].id);
    }
  }, [selectedRunId]);

  const refreshArtifacts = useCallback(async (runId: string) => {
    const payload = await api.listArtifacts(runId);
    setArtifacts(payload.artifacts);
    const docs = await Promise.all(
      payload.artifacts.map(async (artifact) => {
        try {
          const response = await api.readArtifact(runId, artifact.path);
          return [artifact.path, response.artifact] as const;
        } catch {
          return [artifact.path, undefined] as const;
        }
      }),
    );
    setArtifactDocsByPath(
      Object.fromEntries(docs.filter((entry): entry is readonly [string, ArtifactDocument] => Boolean(entry[1]))),
    );
  }, []);

  const openArtifact = useCallback(
    async (artifact: ArtifactRef) => {
      if (!selectedRunId) {
        return;
      }
      const payload = await api.readArtifact(selectedRunId, artifact.path);
      setSelectedArtifact(payload.artifact);
      setArtifactDocsByPath((current) => ({ ...current, [artifact.path]: payload.artifact }));
    },
    [selectedRunId],
  );

  useEffect(() => {
    api.health().then(setHealth).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    refreshRuns().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refreshRuns]);

  useEffect(() => {
    api
      .getMemory(effectiveDomain)
      .then((payload) => setMemoryDocs(payload.memory))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [effectiveDomain]);

  useEffect(() => {
    if (!selectedRunId) {
      setStreamState("idle");
      return;
    }
    eventSourceRef.current?.close();
    setStreamState("connecting");
    setEvents([]);
    setSelectedArtifact(undefined);

    api
      .getEventHistory(selectedRunId)
      .then((payload) => setEvents((current) => mergeEvents(current, payload.events)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    refreshArtifacts(selectedRunId).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    const source = api.eventSource(selectedRunId);
    eventSourceRef.current = source;
    source.onopen = () => {
      setStreamState("live");
      api
        .getEventHistory(selectedRunId)
        .then((payload) => setEvents((current) => mergeEvents(current, payload.events)))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ResearchEvent;
        setEvents((current) => mergeEvents(current, [event]));
      } catch {
        // Named SSE events are handled below.
      }
    };
    const eventNames: ResearchEvent["type"][] = [
      "run.created",
      "run.updated",
      "agent.started",
      "agent.finished",
      "agent.message.delta",
      "tool.started",
      "tool.finished",
      "artifact.created",
      "artifact.updated",
      "claim.challenged",
      "insight.created",
      "deep_dive.started",
      "deep_dive.finished",
      "run.finished",
      "continuation.started",
      "continuation.finished",
      "run.failed",
    ];
    for (const name of eventNames) {
      source.addEventListener(name, (message) => {
        const event = JSON.parse((message as MessageEvent).data) as ResearchEvent;
        setEvents((current) => mergeEvents(current, [event]));
        if (event.type === "artifact.created" || event.type === "artifact.updated" || event.type === "run.finished") {
          refreshArtifacts(selectedRunId).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }
        if (event.type === "artifact.updated" && selectedArtifactRef.current?.id === event.artifact.id) {
          api
            .readArtifactById(selectedRunId, event.artifact.id)
            .then((payload) => {
              setSelectedArtifact(payload.artifact);
              setArtifactDocsByPath((current) => ({ ...current, [payload.artifact.path]: payload.artifact }));
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }
        if (event.type === "run.updated" || event.type === "run.finished" || event.type === "run.failed") {
          refreshRuns().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }
      });
    }
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStreamState("closed");
        setError("Live event stream disconnected.");
      } else {
        setStreamState("reconnecting");
      }
    };
    return () => {
      source.close();
      setStreamState("closed");
    };
  }, [refreshArtifacts, refreshRuns, selectedRunId]);

  useEffect(() => {
    if (!selectedArtifact && latestReport && activeTab === "report") {
      openArtifact(latestReport).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, [activeTab, latestReport, openArtifact, selectedArtifact]);

  useEffect(() => {
    if (selectedArtifact) {
      setFeedbackDimension(defaultFeedbackDimension(selectedArtifact.kind));
      setFeedbackNote("");
    }
  }, [selectedArtifact]);

  useEffect(() => {
    selectedArtifactRef.current = selectedArtifact;
  }, [selectedArtifact]);

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setIsStarting(true);
    try {
      const payload = await api.createRun({ query, domain: domain.trim() || undefined, maxSearchTasks: 6 });
      setRuns((current) => [payload.run, ...current.filter((run) => run.id !== payload.run.id)]);
      setSelectedRunId(payload.run.id);
      setActiveTab("report");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  }

  async function sendFeedback(rating: FeedbackRequest["rating"]) {
    if (!selectedRunId || !selectedArtifact) {
      return;
    }
    setError(undefined);
    setFeedbackInFlight(rating);
    try {
      await api.addFeedback(selectedRunId, {
        artifactId: selectedArtifact.id,
        rating,
        dimension: feedbackDimension,
        note: feedbackNote.trim() || undefined,
      });
      setFeedbackNote("");
      await refreshArtifacts(selectedRunId);
      const payload = await api.readArtifactById(selectedRunId, selectedArtifact.id);
      setSelectedArtifact(payload.artifact);
      setArtifactDocsByPath((current) => ({ ...current, [payload.artifact.path]: payload.artifact }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFeedbackInFlight(undefined);
    }
  }

  async function cancelSelectedRun() {
    if (!selectedRunId) {
      return;
    }
    setError(undefined);
    setIsCancelling(true);
    try {
      const payload = await api.cancelRun(selectedRunId);
      if (!payload.cancelled) {
        setError("Run is no longer active.");
      }
      await refreshRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCancelling(false);
    }
  }

  async function continueFromArtifact() {
    if (!selectedRunId || !selectedArtifact) {
      return;
    }
    setError(undefined);
    setIsContinuing(true);
    try {
      const input =
        selectedArtifact.kind === "question"
          ? { questionId: selectedArtifact.id, maxSearchTasks: 3 }
          : {
              prompt: `Deepen this artifact and look for independent corroboration, contradictions, and new insight:\n\n${selectedArtifact.body.slice(
                0,
                1_500,
              )}`,
              maxSearchTasks: 3,
            };
      const payload = await api.continueRun(selectedRunId, input);
      setRuns((current) => current.map((run) => (run.id === payload.run.id ? payload.run : run)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsContinuing(false);
    }
  }

  const activeAgents = useMemo(() => {
    const active = new Map<string, ResearchEvent & { type: "agent.started" }>();
    for (const event of events) {
      if (isTerminalRunEvent(event)) {
        active.clear();
      }
      if (event.type === "agent.started") {
        active.set(event.taskId, event);
      }
      if (event.type === "agent.finished") {
        active.delete(event.taskId);
      }
    }
    return [...active.values()].slice(-8);
  }, [events]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Flame size={18} />
          </div>
          <div className="brand-copy">
            <div className="brand-title">FireDeepResearch</div>
            <div className="brand-subtitle">Markdown-native</div>
          </div>
          <button
            className="icon-button theme-toggle"
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>

        <div className="status-grid">
          <div className="status-tile">
            <Search size={15} />
            <span>{health?.searchProviders.join(", ") || "providers"}</span>
          </div>
          <div className="status-tile">
            <ShieldCheck size={15} />
            <span>{health?.fetchProvider || "fetch"}</span>
          </div>
          <div className="status-tile">
            <Brain size={15} />
            <span>{formatLlmRuntime(health)}</span>
          </div>
          <div className="status-tile">
            <Gauge size={15} />
            <span>
              {health
                ? `${health.researchLimits.maxSearchAgents}/${health.researchLimits.maxReaderAgents}/${health.researchLimits.maxCritiqueAgents}`
                : "limits"}
            </span>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="section-label">
            <History size={14} />
            Runs
          </div>
          <div className="run-list">
            {runs.map((run) => (
              <button
                key={run.id}
                className={cn("run-item", selectedRunId === run.id && "is-selected")}
                onClick={() => setSelectedRunId(run.id)}
              >
                <span className="run-query">{run.query}</span>
                {run.domain ? <span className="run-domain">{run.domain}</span> : null}
                <span className={cn("run-status", run.status)}>{run.status}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-section memory-section">
          <div className="section-label">
            <BookOpen size={14} />
            Memory
          </div>
          <div className="memory-list">
            {[...memoryDocs.domain, ...memoryDocs.global].slice(0, 5).map((doc) => (
              <div className="memory-item" key={`${doc.kind}-${doc.path}`}>
                <span>{doc.title}</span>
                <small>{doc.path}</small>
                <p>{compactBody(doc.body)}</p>
              </div>
            ))}
            {memoryDocs.domain.length + memoryDocs.global.length === 0 ? <div className="empty-state">No memory loaded</div> : null}
          </div>
        </div>
      </aside>

      <main className="main-pane">
        <form className="query-bar" onSubmit={startRun}>
          <div className="query-input-wrap">
            <Search size={17} />
            <div className="query-fields">
              <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} />
              <div className="domain-field">
                <BookOpen size={14} />
                <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="Domain memory" />
              </div>
            </div>
          </div>
          <button className="primary-button" disabled={isStarting || query.trim().length < 3}>
            {isStarting ? <RefreshCw size={16} className="spin" /> : <Sparkles size={16} />}
            Start
          </button>
        </form>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="run-overview">
          <div className="metric-card">
            <Gauge size={16} />
            <div>
              <span>{selectedRun?.status ?? "idle"}</span>
              <small>{selectedRun ? formatTime(selectedRun.updatedAt) : "No active run"}</small>
            </div>
          </div>
          <div className="metric-card">
            <FileText size={16} />
            <div>
              <span>{artifacts.length}</span>
              <small>artifacts</small>
            </div>
          </div>
          <div className="metric-card">
            <Brain size={16} />
            <div>
              <span>{activeAgents.length}</span>
              <small>{runTelemetry.finishedAgentCount} finished</small>
            </div>
          </div>
          <div className="metric-card">
            <BadgeCheck size={16} />
            <div>
              <span>{artifactCounts.claim}</span>
              <small>claims</small>
            </div>
          </div>
          <div className="metric-card">
            <Activity size={16} />
            <div>
              <span>{formatDuration(runTelemetry.runtimeMs) || "0ms"}</span>
              <small>
                {formatDuration(runTelemetry.averageAgentDurationMs) || "avg n/a"}
                {runTelemetry.toolFailureCount > 0 ? `, ${runTelemetry.toolFailureCount} tool fail` : ""}
                {runTelemetry.fallbackAgentCount > 0 ? `, ${runTelemetry.fallbackAgentCount} fallback` : ""}
              </small>
            </div>
          </div>
        </section>

        <section className="work-grid">
          <div className="panel timeline-panel">
            <div className="panel-header">
              <div>
                <h2>Research Room</h2>
                <p>{selectedRun?.id ?? "No run selected"}</p>
              </div>
              <div className="timeline-actions">
                <span className={cn("stream-pill", `is-${streamState}`)} data-testid="stream-status">
                  <Activity size={13} />
                  {streamStatusLabel(streamState)}
                </span>
                {selectedRun?.status === "running" ? (
                  <button className="ghost-button" onClick={cancelSelectedRun} disabled={isCancelling}>
                    {isCancelling ? <RefreshCw size={15} className="spin" /> : <PauseCircle size={15} />}
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>

            <div className="agent-strip">
              {activeAgents.length === 0 ? (
                <div className="empty-state">No active agents</div>
              ) : (
                activeAgents.map((agent) => (
                  <div className="agent-card" key={agent.taskId}>
                    <Brain size={16} />
                    <span>{agent.agent}</span>
                    <small>{agent.label}</small>
                  </div>
                ))
              )}
            </div>

            <div className="event-list">
              {events.slice(-80).reverse().map((event, index) => (
                <div className="event-row" key={`${event.type}-${event.at}-${index}`}>
                  <div className="event-icon">{eventIcon(event)}</div>
                  <div className="event-copy">
                    <div>
                      <span>{eventLabel(event)}</span>
                      <small>{formatTime(event.at)}</small>
                    </div>
                    {eventDetail(event) ? <p>{eventDetail(event)}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel artifact-panel">
            <div className="tabs">
              {(Object.keys(tabLabels) as ArtifactTab[]).map((tab) => (
                <button key={tab} className={cn(activeTab === tab && "is-active")} onClick={() => setActiveTab(tab)}>
                  {tabLabels[tab]}
                  <span>{artifactCounts[tab]}</span>
                </button>
              ))}
            </div>

            <div className="artifact-list">
              {visibleArtifacts.map((artifact) => (
                <button
                  key={artifact.path}
                  className={cn("artifact-item", selectedArtifact?.path === artifact.path && "is-selected")}
                  onClick={() => openArtifact(artifact)}
                >
                  <span>{artifact.title}</span>
                  <small>{artifact.path}</small>
                </button>
              ))}
              {visibleArtifacts.length === 0 ? <div className="empty-state">No artifacts</div> : null}
            </div>
          </div>
        </section>
      </main>

      <aside className="detail-pane">
        <div className="panel detail-panel">
          <div className="panel-header">
            <div>
              <h2>{selectedArtifact?.title ?? "Artifact"}</h2>
              <p>{selectedArtifact?.path ?? "Select an artifact"}</p>
            </div>
            {selectedArtifact ? (
              <div className="feedback-buttons">
                <button
                  className="ghost-button"
                  onClick={continueFromArtifact}
                  disabled={isContinuing || selectedRun?.status === "running"}
                  title="Deepen this artifact"
                  data-testid="deepen-artifact"
                >
                  {isContinuing ? <RefreshCw size={15} className="spin" /> : <Sparkles size={15} />}
                  Deepen
                </button>
                <button
                  className="icon-button"
                  onClick={() => sendFeedback("up")}
                  title="Upvote"
                  disabled={Boolean(feedbackInFlight)}
                  data-testid="feedback-up"
                >
                  {feedbackInFlight === "up" ? <RefreshCw size={15} className="spin" /> : <ThumbsUp size={15} />}
                </button>
                <button
                  className="icon-button"
                  onClick={() => sendFeedback("down")}
                  title="Downvote"
                  disabled={Boolean(feedbackInFlight)}
                  data-testid="feedback-down"
                >
                  {feedbackInFlight === "down" ? <RefreshCw size={15} className="spin" /> : <ThumbsDown size={15} />}
                </button>
              </div>
            ) : null}
          </div>

          {selectedArtifact ? (
            <>
              <div className="feedback-composer">
                <select
                  value={feedbackDimension}
                  onChange={(event) => setFeedbackDimension(event.target.value as FeedbackRequest["dimension"])}
                  title="Feedback dimension"
                  data-testid="feedback-dimension"
                >
                  {(Object.keys(feedbackDimensionLabels) as FeedbackRequest["dimension"][]).map((dimension) => (
                    <option key={dimension} value={dimension}>
                      {feedbackDimensionLabels[dimension]}
                    </option>
                  ))}
                </select>
                <input
                  value={feedbackNote}
                  onChange={(event) => setFeedbackNote(event.target.value)}
                  placeholder="Feedback note"
                  title="Feedback note"
                  data-testid="feedback-note"
                />
              </div>
              <div className="frontmatter">
                {Object.entries(selectedArtifact.frontmatter).slice(0, 8).map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <code>{Array.isArray(value) ? value.join(", ") : String(value)}</code>
                  </div>
                ))}
              </div>
              {linkedArtifacts.length > 0 ? (
                <div className="linked-artifacts">
                  <div className="linked-title">Related artifacts</div>
                  <div className="linked-list">
                    {linkedArtifacts.map((artifact) => (
                      <button key={artifact.path} onClick={() => openArtifact(artifact)}>
                        <FileText size={13} />
                        <span>{artifact.id}</span>
                        <small>{artifact.kind}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <MarkdownView body={selectedArtifact.body} artifactById={artifactById} onArtifactRefClick={openArtifact} />
            </>
          ) : (
            <div className="empty-detail">
              <BookOpen size={26} />
              <span>Evidence panel</span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
