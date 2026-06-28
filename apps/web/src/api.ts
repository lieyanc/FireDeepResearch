import type { ArtifactDocument, ArtifactRef, FeedbackRequest, ResearchEvent, ResearchRun, RunCreateRequest } from "@fdr/schemas";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const api = {
  apiUrl: API_URL,

  health() {
    return request<{ ok: boolean; dataDir: string; searchProviders: string[]; fetchProvider: string }>("/api/health");
  },

  listRuns() {
    return request<{ runs: ResearchRun[] }>("/api/runs");
  },

  createRun(input: RunCreateRequest) {
    return request<{ run: ResearchRun }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getRun(runId: string) {
    return request<{ run: ResearchRun }>(`/api/runs/${encodeURIComponent(runId)}`);
  },

  getEventHistory(runId: string) {
    return request<{ events: ResearchEvent[] }>(`/api/runs/${encodeURIComponent(runId)}/events/history`);
  },

  listArtifacts(runId: string) {
    return request<{ artifacts: ArtifactRef[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  },

  readArtifact(runId: string, path: string) {
    return request<{ artifact: ArtifactDocument }>(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/content?path=${encodeURIComponent(path)}`,
    );
  },

  addFeedback(runId: string, feedback: FeedbackRequest) {
    return request<{ artifact: ArtifactRef }>(`/api/runs/${encodeURIComponent(runId)}/feedback`, {
      method: "POST",
      body: JSON.stringify(feedback),
    });
  },

  cancelRun(runId: string) {
    return request<{ cancelled: boolean }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  },

  eventSource(runId: string) {
    return new EventSource(`${API_URL}/api/runs/${encodeURIComponent(runId)}/events`);
  },
};

