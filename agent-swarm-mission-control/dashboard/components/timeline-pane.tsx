"use client";

import { useMemo, useState } from "react";
import type { AgentRole, AgentStateDerived, AnyEventEnvelope, TaskStateDerived } from "@mission-control/shared";

interface TimelinePaneProps {
  events: AnyEventEnvelope[];
  agents: Record<string, AgentStateDerived>;
  tasks: Record<string, TaskStateDerived>;
  at: number;
  selectedEventId?: string;
  onSelectEvent: (event: AnyEventEnvelope) => void;
  roleFilter: AgentRole | "all";
  statusFilter: TaskStateDerived["status"] | "all";
  errorsOnly: boolean;
}

function eventAgentId(event: AnyEventEnvelope, tasks: Record<string, TaskStateDerived>): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.agentId === "string") {
    return payload.agentId;
  }
  if (typeof payload.toAgentId === "string") {
    return payload.toAgentId;
  }
  if (typeof payload.ownerPlannerId === "string") {
    return payload.ownerPlannerId;
  }
  if (typeof payload.taskId === "string") {
    return tasks[payload.taskId]?.assignedAgentId;
  }
  return undefined;
}

function eventTaskId(event: AnyEventEnvelope): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.taskId === "string" ? payload.taskId : undefined;
}

function isErrorEvent(event: AnyEventEnvelope): boolean {
  switch (event.type) {
    case "task.status_changed":
      return event.payload.status === "failed";
    case "agent.state_changed":
      return event.payload.state === "failed";
    case "tool.finished":
      return !event.payload.ok;
    case "tests.result":
      return !event.payload.ok;
    default:
      return false;
  }
}

function eventLabel(event: AnyEventEnvelope): string {
  switch (event.type) {
    case "task.status_changed":
      return `${event.type} ${event.payload.taskId} -> ${event.payload.status}`;
    case "task.assigned":
      return `${event.type} ${event.payload.taskId} -> ${event.payload.agentId}`;
    case "agent.state_changed":
      return `${event.type} ${event.payload.agentId} -> ${event.payload.state}`;
    case "git.commit_created":
      return `${event.type} ${event.payload.sha.slice(0, 8)} ${event.payload.message}`;
    default:
      return `${event.type}`;
  }
}

export function TimelinePane({
  events,
  agents,
  tasks,
  at,
  selectedEventId,
  onSelectEvent,
  roleFilter,
  statusFilter,
  errorsOnly
}: TimelinePaneProps) {
  const [zoom, setZoom] = useState(1);

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (errorsOnly && !isErrorEvent(event)) {
        return false;
      }

      if (statusFilter !== "all") {
        const taskId = eventTaskId(event);
        if (taskId && tasks[taskId] && tasks[taskId].status !== statusFilter) {
          return false;
        }
      }

      if (roleFilter !== "all") {
        const agentId = eventAgentId(event, tasks);
        if (!agentId || agents[agentId]?.role !== roleFilter) {
          return false;
        }
      }

      return true;
    });
  }, [agents, errorsOnly, events, roleFilter, statusFilter, tasks]);

  const timeMin = filteredEvents[0]?.ts ?? at;
  const timeMax = filteredEvents[filteredEvents.length - 1]?.ts ?? at;
  const width = 680 * zoom;

  const lanes = useMemo(() => {
    const laneMap = new Map<string, AnyEventEnvelope[]>();
    for (const event of filteredEvents) {
      const lane = eventAgentId(event, tasks) ?? "system";
      if (!laneMap.has(lane)) {
        laneMap.set(lane, []);
      }
      laneMap.get(lane)?.push(event);
    }

    return [...laneMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredEvents, tasks]);

  const timeToX = (ts: number): number => {
    if (timeMax === timeMin) {
      return 80;
    }
    return 80 + ((ts - timeMin) / (timeMax - timeMin)) * (width - 120);
  };

  return (
    <section className="pane">
      <div className="pane-header">
        <h2>Timeline & Replay</h2>
        <div className="row compact">
          <label className="muted" htmlFor="zoom-range">
            zoom
          </label>
          <input
            id="zoom-range"
            type="range"
            min={1}
            max={5}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <span className="mono">{zoom}x</span>
        </div>
      </div>

      <div className="timeline-svg-wrap">
        <svg width={width} height={Math.max(160, lanes.length * 46 + 50)}>
          <line x1={timeToX(at)} y1={8} x2={timeToX(at)} y2={Math.max(160, lanes.length * 46 + 40)} stroke="#0b7285" strokeWidth={2} />
          {lanes.map(([lane, laneEvents], index) => {
            const y = 30 + index * 46;
            return (
              <g key={lane}>
                <line x1={60} y1={y} x2={width - 30} y2={y} stroke="#d7dce7" strokeWidth={1} />
                <text x={6} y={y + 4} fontSize={11} className="mono" fill="#4a5568">
                  {lane.slice(0, 14)}
                </text>
                {laneEvents.map((laneEvent, laneIndex) => {
                  const x = timeToX(laneEvent.ts);
                  const selected = laneEvent.eventId === selectedEventId;
                  return (
                    <g key={laneEvent.eventId} onClick={() => onSelectEvent(laneEvent)} style={{ cursor: "pointer" }}>
                      {laneIndex > 0 ? (
                        <line
                          x1={timeToX(laneEvents[laneIndex - 1].ts)}
                          y1={y}
                          x2={x}
                          y2={y}
                          stroke="#9ca8bf"
                          strokeWidth={1.5}
                        />
                      ) : null}
                      <circle cx={x} cy={y} r={selected ? 6 : 4} fill={isErrorEvent(laneEvent) ? "#c92a2a" : "#0b7285"} />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="event-list">
        {filteredEvents
          .slice()
          .reverse()
          .map((event) => (
            <button
              key={event.eventId}
              className={`event-row ${event.eventId === selectedEventId ? "selected" : ""}`}
              onClick={() => onSelectEvent(event)}
            >
              <span className="mono">{new Date(event.ts).toLocaleTimeString()}</span>
              <span>{eventLabel(event)}</span>
            </button>
          ))}
      </div>
    </section>
  );
}
