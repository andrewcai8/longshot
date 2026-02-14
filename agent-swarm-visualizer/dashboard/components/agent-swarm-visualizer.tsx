"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  deriveStateFromEvents,
  type AgentRole,
  type AnyEventEnvelope,
  type TaskStatus
} from "@agent-swarm-visualizer/shared";
import { CommitPane } from "@/components/commit-pane";
import { PlannerTreePane } from "@/components/planner-tree-pane";
import { TimelinePane } from "@/components/timeline-pane";
import { connectStream, createRun, getEvents, getState, listRuns } from "@/lib/api";

function maxTs(events: AnyEventEnvelope[]): number {
  return events[events.length - 1]?.ts ?? 0;
}

function asSorted(events: AnyEventEnvelope[]): AnyEventEnvelope[] {
  return [...events].sort((a, b) => (a.ts === b.ts ? a.eventId.localeCompare(b.eventId) : a.ts - b.ts));
}

function computeDefaultCollapsed(plannerTree: ReturnType<typeof deriveStateFromEvents>["plannerTree"]) {
  const collapsed = new Set<string>();

  const dfs = (agentId: string): boolean => {
    const node = plannerTree.nodes[agentId];
    if (!node) {
      return true;
    }

    const childDone = node.childAgentIds.map((child) => dfs(child)).every(Boolean);
    const done = node.state === "done";
    if (done && childDone && node.childAgentIds.length > 0) {
      collapsed.add(agentId);
    }

    return done && childDone;
  };

  plannerTree.rootAgentIds.forEach((root) => {
    dfs(root);
  });

  return collapsed;
}

export function AgentSwarmVisualizer() {
  const [runs, setRuns] = useState<Array<{ runId: string; name: string; createdAt: number }>>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [events, setEvents] = useState<AnyEventEnvelope[]>([]);
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "live" | "closed" | "error" | "idle">("idle");
  const [scrubberAt, setScrubberAt] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<1 | 4>(1);

  const [roleFilter, setRoleFilter] = useState<AgentRole | "all">("all");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [errorsOnly, setErrorsOnly] = useState(false);

  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | undefined>();
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();

  const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(new Set());
  const [collapseInitializedForRun, setCollapseInitializedForRun] = useState<string | undefined>();

  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const eventIdsRef = useRef<Set<string>>(new Set());
  const connectionStatusRef = useRef(connectionStatus);

  const currentAt = mode === "live" ? maxTs(events) : scrubberAt;
  const state = useMemo(() => deriveStateFromEvents(events, currentAt), [events, currentAt]);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  useEffect(() => {
    let active = true;

    const refreshRuns = async () => {
      try {
        const data = await listRuns();
        if (!active) {
          return;
        }
        setRuns(data.runs);
        setSelectedRunId((previous) => previous ?? data.runs[0]?.runId);
      } catch (nextError) {
        if (!active) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : "Unable to load runs");
      }
    };

    void refreshRuns();
    const intervalId = window.setInterval(() => {
      void refreshRuns();
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    void (async () => {
      try {
        setError(null);
        const [eventsResult] = await Promise.all([getEvents(selectedRunId), getState(selectedRunId)]);
        const sorted = asSorted(eventsResult.events);
        eventIdsRef.current = new Set(sorted.map((event) => event.eventId));
        setEvents(sorted);
        setScrubberAt(maxTs(sorted));
        setMode("live");
        setSelectedEventId(undefined);
        setSelectedAgentId(undefined);
        setSelectedCommitSha(undefined);
        setCollapseInitializedForRun(undefined);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Unable to load run events");
      }
    })();
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || mode !== "live") {
      wsRef.current?.close();
      wsRef.current = null;
      if (mode !== "live") {
        setConnectionStatus("closed");
      }
      return;
    }

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let reconnectScheduled = false;

    const openSocket = () => {
      if (cancelled) {
        return;
      }

      const socket = connectStream(
        selectedRunId,
        (event) => {
          if (eventIdsRef.current.has(event.eventId)) {
            return;
          }
          eventIdsRef.current.add(event.eventId);
          setEvents((previous) => asSorted([...previous, event]));
        },
        (status) => {
          setConnectionStatus(status);

          if (status === "live") {
            reconnectScheduled = false;
            if (reconnectTimer !== undefined) {
              window.clearTimeout(reconnectTimer);
              reconnectTimer = undefined;
            }
            return;
          }

          if ((status === "closed" || status === "error") && !cancelled && !reconnectScheduled) {
            reconnectScheduled = true;
            reconnectTimer = window.setTimeout(() => {
              reconnectScheduled = false;
              openSocket();
            }, 1000);
          }
        }
      );

      wsRef.current = socket;
    };

    openSocket();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [mode, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || mode !== "live") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        if (connectionStatusRef.current === "live") {
          return;
        }
        try {
          const response = await getEvents(selectedRunId);
          const unseen = response.events.filter((event) => !eventIdsRef.current.has(event.eventId));
          if (unseen.length === 0) {
            return;
          }
          for (const event of unseen) {
            eventIdsRef.current.add(event.eventId);
          }
          setEvents((previous) => asSorted([...previous, ...unseen]));
        } catch {
          // Keep silent: websocket is primary transport and polling is best-effort fallback.
        }
      })();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [mode, selectedRunId]);

  useEffect(() => {
    if (mode !== "replay" || !isPlaying) {
      return;
    }

    const max = maxTs(events);
    const interval = setInterval(() => {
      setScrubberAt((previous) => {
        const next = Math.min(max, previous + 250 * playSpeed);
        if (next >= max) {
          setIsPlaying(false);
        }
        return next;
      });
    }, 250);

    return () => {
      clearInterval(interval);
    };
  }, [events, isPlaying, mode, playSpeed]);

  useEffect(() => {
    if (!selectedRunId || collapseInitializedForRun === selectedRunId) {
      return;
    }
    const defaults = computeDefaultCollapsed(state.plannerTree);
    setCollapsedAgentIds(defaults);
    setCollapseInitializedForRun(selectedRunId);
  }, [collapseInitializedForRun, selectedRunId, state.plannerTree]);

  const handleCreateRun = async () => {
    const name = window.prompt("Run name", `Demo Run ${new Date().toLocaleTimeString()}`);
    if (!name) {
      return;
    }

    try {
      const created = await createRun({ name });
      const nextRuns = await listRuns();
      setRuns(nextRuns.runs);
      setSelectedRunId(created.runId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to create run");
    }
  };

  const handleSelectEvent = (event: AnyEventEnvelope) => {
    setSelectedEventId(event.eventId);
    setMode("replay");
    setScrubberAt(event.ts);

    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.agentId === "string") {
      setSelectedAgentId(payload.agentId);
    }

    if (event.type === "git.commit_created") {
      setSelectedCommitSha(event.payload.sha);
    }

    if (event.type === "tests.result") {
      setSelectedCommitSha(event.payload.sha);
    }
  };

  const timelineMax = maxTs(events);
  const timelineMin = events[0]?.ts ?? timelineMax;
  const showTimes = events.length > 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Agent Swarm Visualizer</h1>
          <p className="muted">Event-sourced local dashboard with live + replay modes</p>
        </div>

        <div className="status-card">
          <span className="mono">conn: {connectionStatus}</span>
          <span className="mono">events: {events.length}</span>
          <span className="mono">at: {showTimes ? new Date(currentAt).toLocaleTimeString() : "--:--:--"}</span>
        </div>
      </header>

      <section className="controls">
        <div className="row">
          <label htmlFor="run-select">Run</label>
          <select
            id="run-select"
            value={selectedRunId ?? ""}
            onChange={(event) => setSelectedRunId(event.target.value || undefined)}
          >
            <option value="">Select run</option>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.name} ({new Date(run.createdAt).toLocaleTimeString()})
              </option>
            ))}
          </select>
          <button className="small" onClick={handleCreateRun}>
            New Run
          </button>
        </div>

        <div className="row">
          <button className={`small ${mode === "live" ? "active" : ""}`} onClick={() => setMode("live")}>Live</button>
          <button className={`small ${mode === "replay" ? "active" : ""}`} onClick={() => setMode("replay")}>Replay</button>
          <button className="small" onClick={() => setIsPlaying((previous) => !previous)} disabled={mode !== "replay"}>
            {isPlaying ? "Pause" : "Play"}
          </button>
          <select value={playSpeed} onChange={(event) => setPlaySpeed(Number(event.target.value) as 1 | 4)} disabled={mode !== "replay"}>
            <option value={1}>1x</option>
            <option value={4}>4x</option>
          </select>
        </div>

        <div className="row scrubber">
          <span className="mono">{showTimes ? new Date(scrubberAt).toLocaleTimeString() : "--:--:--"}</span>
          <input
            type="range"
            min={timelineMin}
            max={timelineMax}
            value={mode === "live" ? timelineMax : scrubberAt}
            onChange={(event) => {
              setMode("replay");
              setScrubberAt(Number(event.target.value));
            }}
            disabled={events.length < 2}
          />
          <span className="mono">{showTimes ? new Date(timelineMax).toLocaleTimeString() : "--:--:--"}</span>
        </div>

        <div className="row">
          <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as AgentRole | "all")}>
            <option value="all">All Roles</option>
            <option value="root_planner">Root Planner</option>
            <option value="planner">Planner</option>
            <option value="subplanner">Subplanner</option>
            <option value="worker">Worker</option>
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")}> 
            <option value="all">All Task Statuses</option>
            <option value="backlog">backlog</option>
            <option value="in_progress">in_progress</option>
            <option value="blocked">blocked</option>
            <option value="done">done</option>
            <option value="failed">failed</option>
            <option value="retry">retry</option>
          </select>
          <label className="row compact checkbox">
            <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />
            Errors only
          </label>
        </div>

        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="pane-grid">
        <PlannerTreePane
          plannerTree={state.plannerTree}
          agents={state.agents}
          tasks={state.tasks}
          selectedAgentId={selectedAgentId}
          onSelectAgent={(agentId) => {
            setSelectedAgentId(agentId);
            const commit = state.commits.find((item) => item.agentId === agentId);
            if (commit) {
              setSelectedCommitSha(commit.sha);
            }
          }}
          collapsedAgentIds={collapsedAgentIds}
          onToggleCollapse={(agentId) => {
            setCollapsedAgentIds((previous) => {
              const next = new Set(previous);
              if (next.has(agentId)) {
                next.delete(agentId);
              } else {
                next.add(agentId);
              }
              return next;
            });
          }}
          roleFilter={roleFilter}
        />

        <TimelinePane
          events={events.filter((event) => event.ts <= currentAt)}
          agents={state.agents}
          tasks={state.tasks}
          at={currentAt}
          selectedEventId={selectedEventId}
          onSelectEvent={handleSelectEvent}
          roleFilter={roleFilter}
          statusFilter={statusFilter}
          errorsOnly={errorsOnly}
        />

        <CommitPane
          runId={selectedRunId}
          commits={state.commits}
          branches={state.branches}
          selectedCommitSha={selectedCommitSha}
          onSelectCommit={(sha) => {
            setSelectedCommitSha(sha);
            const commit = state.commits.find((item) => item.sha === sha);
            if (commit) {
              setSelectedAgentId(commit.agentId);
            }
          }}
          onJumpToTime={(ts) => {
            setMode("replay");
            setScrubberAt(ts);
          }}
        />
      </section>
    </main>
  );
}
