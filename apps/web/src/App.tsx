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
  PauseCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

type ArtifactTab = "report" | "claim" | "source" | "question" | "insight" | "audit";

interface HealthState {
  ok: boolean;
  dataDir: string;
  searchProviders: string[];
  fetchProvider: string;
}

const SAMPLE_QUERY =
  "Research the 2026 AI coding agent market and identify which startups or product strategies have the strongest enterprise opportunity.";

const tabLabels: Record<ArtifactTab, string> = {
  report: "Report",
  claim: "Claims",
  source: "Sources",
  question: "Questions",
  insight: "Insights",
  audit: "Audit",
};

const tabKinds: Record<ArtifactTab, ArtifactKind[]> = {
  report: ["report"],
  claim: ["claim"],
  source: ["source"],
  question: ["question", "critique"],
  insight: ["insight"],
  audit: ["audit"],
};

function cn(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
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
    case "claim.challenged":
      return `${event.claimId} challenged`;
    case "insight.created":
      return `${event.insightId} created`;
    case "run.finished":
      return "Run finished";
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
  if (event.type === "claim.challenged") {
    return <MessageSquareWarning size={15} />;
  }
  if (event.type === "artifact.created") {
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
    case "agent.message.delta":
      return event.text;
    case "artifact.created":
      return event.artifact.title;
    case "claim.challenged":
      return `${event.questionId} (${event.severity})`;
    case "run.failed":
      return event.error;
    case "run.finished":
      return event.reportPath;
    default:
      return "";
  }
}

function MarkdownView({ body }: { body: string }) {
  const blocks = body.split("\n");
  return (
    <div className="markdown-view">
      {blocks.map((line, index) => {
        if (line.startsWith("# ")) {
          return <h1 key={index}>{line.slice(2)}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={index}>{line.slice(3)}</h2>;
        }
        if (line.startsWith("### ")) {
          return <h3 key={index}>{line.slice(4)}</h3>;
        }
        if (line.startsWith("> ")) {
          return <blockquote key={index}>{line.slice(2)}</blockquote>;
        }
        if (line.startsWith("- ")) {
          return <li key={index}>{line.slice(2)}</li>;
        }
        if (!line.trim()) {
          return <div key={index} className="md-gap" />;
        }
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

export function App() {
  const [query, setQuery] = useState(SAMPLE_QUERY);
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactDocument>();
  const [activeTab, setActiveTab] = useState<ArtifactTab>("report");
  const [health, setHealth] = useState<HealthState>();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string>();
  const eventSourceRef = useRef<EventSource | null>(null);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId), [runs, selectedRunId]);

  const artifactCounts = useMemo(() => {
    return Object.fromEntries(
      Object.entries(tabKinds).map(([tab, kinds]) => [tab, artifacts.filter((artifact) => kinds.includes(artifact.kind)).length]),
    ) as Record<ArtifactTab, number>;
  }, [artifacts]);

  const visibleArtifacts = useMemo(() => {
    const kinds = tabKinds[activeTab];
    return artifacts.filter((artifact) => kinds.includes(artifact.kind));
  }, [activeTab, artifacts]);

  const latestReport = useMemo(() => {
    return artifacts.find((artifact) => artifact.kind === "report") ?? artifacts.find((artifact) => artifact.path === "final_report.md");
  }, [artifacts]);

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
  }, []);

  const openArtifact = useCallback(
    async (artifact: ArtifactRef) => {
      if (!selectedRunId) {
        return;
      }
      const payload = await api.readArtifact(selectedRunId, artifact.path);
      setSelectedArtifact(payload.artifact);
    },
    [selectedRunId],
  );

  useEffect(() => {
    api.health().then(setHealth).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    refreshRuns().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refreshRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    eventSourceRef.current?.close();
    setEvents([]);
    setSelectedArtifact(undefined);

    api
      .getEventHistory(selectedRunId)
      .then((payload) => setEvents(payload.events))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    refreshArtifacts(selectedRunId).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    const source = api.eventSource(selectedRunId);
    eventSourceRef.current = source;
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ResearchEvent;
        setEvents((current) => [...current, event].slice(-300));
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
      "claim.challenged",
      "insight.created",
      "run.finished",
      "run.failed",
    ];
    for (const name of eventNames) {
      source.addEventListener(name, (message) => {
        const event = JSON.parse((message as MessageEvent).data) as ResearchEvent;
        setEvents((current) => [...current, event].slice(-300));
        if (event.type === "artifact.created" || event.type === "run.finished") {
          refreshArtifacts(selectedRunId).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }
        if (event.type === "run.updated" || event.type === "run.finished" || event.type === "run.failed") {
          refreshRuns().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }
      });
    }
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [refreshArtifacts, refreshRuns, selectedRunId]);

  useEffect(() => {
    if (!selectedArtifact && latestReport && activeTab === "report") {
      openArtifact(latestReport).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, [activeTab, latestReport, openArtifact, selectedArtifact]);

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setIsStarting(true);
    try {
      const payload = await api.createRun({ query, maxSearchTasks: 6 });
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
    await api.addFeedback(selectedRunId, {
      artifactId: selectedArtifact.id,
      rating,
      dimension: selectedArtifact.kind === "source" ? "credibility" : selectedArtifact.kind === "insight" ? "insight_value" : "usefulness",
    });
    await refreshArtifacts(selectedRunId);
  }

  const activeAgents = useMemo(() => {
    const active = new Map<string, ResearchEvent & { type: "agent.started" }>();
    for (const event of events) {
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
          <div>
            <div className="brand-title">FireDeepResearch</div>
            <div className="brand-subtitle">Markdown-native</div>
          </div>
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
                <span className={cn("run-status", run.status)}>{run.status}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main-pane">
        <form className="query-bar" onSubmit={startRun}>
          <div className="query-input-wrap">
            <Search size={17} />
            <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} />
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
              <small>active agents</small>
            </div>
          </div>
          <div className="metric-card">
            <BadgeCheck size={16} />
            <div>
              <span>{artifactCounts.claim}</span>
              <small>claims</small>
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
              {selectedRun?.status === "running" ? (
                <button className="ghost-button" onClick={() => selectedRunId && api.cancelRun(selectedRunId)}>
                  <PauseCircle size={15} />
                  Cancel
                </button>
              ) : null}
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
                <button className="icon-button" onClick={() => sendFeedback("up")} title="Upvote">
                  <ThumbsUp size={15} />
                </button>
                <button className="icon-button" onClick={() => sendFeedback("down")} title="Downvote">
                  <ThumbsDown size={15} />
                </button>
              </div>
            ) : null}
          </div>

          {selectedArtifact ? (
            <>
              <div className="frontmatter">
                {Object.entries(selectedArtifact.frontmatter).slice(0, 8).map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <code>{Array.isArray(value) ? value.join(", ") : String(value)}</code>
                  </div>
                ))}
              </div>
              <MarkdownView body={selectedArtifact.body} />
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
