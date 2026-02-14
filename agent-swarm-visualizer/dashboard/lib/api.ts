import type {
  AnyEventEnvelope,
  CreateRunRequest,
  CreateRunResponse,
  DiffResponse,
  ListRunsResponse,
  QueryEventsResponse,
  StateResponse
} from "@agent-swarm-visualizer/shared";

const DEFAULT_BACKEND_URL = "http://localhost:4000";

function backendUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_BACKEND_URL ?? DEFAULT_BACKEND_URL;
  }
  return process.env.DASHBOARD_BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? DEFAULT_BACKEND_URL;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${backendUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${path} failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

export function getBackendBaseUrl(): string {
  return backendUrl();
}

export async function listRuns(): Promise<ListRunsResponse> {
  return apiFetch<ListRunsResponse>("/v1/runs");
}

export async function createRun(body: CreateRunRequest): Promise<CreateRunResponse> {
  return apiFetch<CreateRunResponse>("/v1/runs", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export async function getEvents(runId: string, until?: number): Promise<QueryEventsResponse> {
  const search = new URLSearchParams({ runId });
  if (until !== undefined) {
    search.set("until", String(until));
  }
  return apiFetch<QueryEventsResponse>(`/v1/events?${search.toString()}`);
}

export async function getState(runId: string, at?: number): Promise<StateResponse> {
  const search = new URLSearchParams({ runId });
  if (at !== undefined) {
    search.set("at", String(at));
  }
  return apiFetch<StateResponse>(`/v1/state?${search.toString()}`);
}

export async function getDiff(runId: string, sha: string): Promise<DiffResponse> {
  const search = new URLSearchParams({ runId });
  return apiFetch<DiffResponse>(`/v1/diff/${encodeURIComponent(sha)}?${search.toString()}`);
}

export function connectStream(
  runId: string,
  onEvent: (event: AnyEventEnvelope) => void,
  onStatus: (status: "connecting" | "live" | "closed" | "error") => void
): WebSocket {
  const base = backendUrl();
  const wsBase = base.startsWith("https") ? base.replace("https", "wss") : base.replace("http", "ws");
  const socket = new WebSocket(`${wsBase}/v1/stream?runId=${encodeURIComponent(runId)}`);

  onStatus("connecting");

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "subscribe", runId }));
  };

  socket.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data);
      if (parsed.type === "hello") {
        onStatus("live");
      }
      if (parsed.type === "event" && parsed.event) {
        onEvent(parsed.event as AnyEventEnvelope);
      }
    } catch {
      onStatus("error");
    }
  };

  socket.onerror = () => {
    onStatus("error");
  };

  socket.onclose = () => {
    onStatus("closed");
  };

  return socket;
}
