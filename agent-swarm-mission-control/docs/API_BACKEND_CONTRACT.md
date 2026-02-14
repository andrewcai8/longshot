# Agent Swarm Mission Control Backend API Contract

This document defines the API that populates the dashboard.

## High-Level Summary

- A **run** is one swarm session. Everything is scoped by `runId`.
- The backend is **event-sourced**: every change is stored as an append-only event in `/v1/events`.
- **Agents** are nodes in the planner tree:
  - roles: `root_planner`, `planner`, `subplanner`, `worker`
  - runtime state: `idle`, `thinking`, `running_tools`, `blocked`, `failed`, `done`
- **Tasks** represent work items created by planners and assigned to agents:
  - status: `backlog`, `in_progress`, `blocked`, `done`, `failed`, `retry`
- **State endpoint (`/v1/state`)** derives current/replayable dashboard state from events:
  - agent map, task map, planner tree, commits, branches, metrics
- **Timeline and replay** are built from `/v1/events` + optional `until/at` timestamps.
- **Artifacts** (commit DAG + diff viewer + test results) are provided via:
  - `git.commit_created`, `git.branch_updated`, `tests.result`, and `/v1/diff/:sha`
- **Live updates** use `WS /v1/stream`; dashboard can also poll `/v1/events` as fallback.
- Convenience endpoints (agents/tasks/git/tests) are wrappers that emit typed events internally.

## Scope

- Service: `backend`
- Purpose: append and query an event-sourced run log, stream live updates, and serve derived state for the dashboard.
- Source of truth in code:
  - `backend/src/server.ts`
  - `shared/src/types.ts`
  - `shared/src/schemas.ts`

## Transport and Conventions

- Base URL (local default): `http://localhost:4000`
- Auth: none (local development)
- Content type: `application/json`
- Time fields: milliseconds since epoch (`number`)
- IDs: string (UUIDs recommended, but not required by API)

## Data Flow (How Dashboard Gets Populated)

1. Create or select a run (`POST /v1/runs`, `GET /v1/runs`)
2. Append events (either generic `/v1/events` or convenience endpoints)
3. Dashboard consumes:
   - live events via `WS /v1/stream?runId=...`
   - replay events via `GET /v1/events`
   - derived snapshot via `GET /v1/state`
   - commit diffs via `GET /v1/diff/:sha`

## Event Model

Each event envelope:

```json
{
  "eventId": "string",
  "runId": "string",
  "ts": 1730000000000,
  "type": "agent.spawned",
  "payload": {}
}
```

Supported `type` values:

- `agent.spawned`
- `agent.state_changed`
- `task.created`
- `task.assigned`
- `task.status_changed`
- `handoff.submitted`
- `tool.called`
- `tool.finished`
- `git.commit_created`
- `git.branch_updated`
- `tests.result`

## Endpoint Reference (Human)

### 1) Runs

#### `POST /v1/runs`
Create a run container.

Request:

```json
{ "name": "Demo Run" }
```

Response:

```json
{ "runId": "<uuid>" }
```

#### `GET /v1/runs`
List runs (newest first).

Response:

```json
{
  "runs": [
    { "runId": "...", "name": "Demo Run", "createdAt": 1730000000000 }
  ]
}
```

---

### 2) Generic Event Append + Replay

#### `POST /v1/events`
Append one or more event envelopes for a run.

Request:

```json
{
  "runId": "...",
  "events": [
    {
      "eventId": "...",
      "runId": "...",
      "ts": 1730000000000,
      "type": "agent.spawned",
      "payload": {
        "agentId": "root-1",
        "role": "root_planner",
        "name": "Root"
      }
    }
  ]
}
```

Response:

```json
{ "ok": true, "inserted": 1 }
```

#### `GET /v1/events?runId=...&until=...`
Query event log for replay. `until` is optional.

Response:

```json
{ "events": [/* EventEnvelope[] */] }
```

---

### 3) Derived Dashboard Snapshot

#### `GET /v1/state?runId=...&at=...`
Build derived state from events up to `at` (optional).

Response shape:

```json
{
  "at": 1730000000000,
  "agents": {},
  "tasks": {},
  "plannerTree": { "rootAgentIds": [], "nodes": {} },
  "commits": [],
  "branches": [],
  "metrics": {
    "commitsPerHour": 0,
    "eventsPerMinute": 0,
    "failureRate": 0,
    "testsPassRate": 0
  }
}
```

---

### 4) Commit Diff Query

#### `GET /v1/diff/:sha?runId=...`
Get diff payload for one commit.

Response:

```json
{
  "sha": "...",
  "files": [
    {
      "path": "src/file.ts",
      "status": "modified",
      "patch": "@@ ..."
    }
  ],
  "unified": "diff --git ..."
}
```

---

### 5) Convenience Endpoints (Append-Event Wrappers)

These endpoints are stable integration points. Internally each emits exactly one event and appends to event log.

#### `POST /v1/agents/create`
Request:

```json
{
  "runId": "...",
  "agent": {
    "agentId": "root-1",
    "role": "root_planner",
    "parentAgentId": "optional",
    "name": "optional"
  }
}
```

Response:

```json
{ "ok": true }
```

#### `POST /v1/tasks/create`
Request:

```json
{
  "runId": "...",
  "task": {
    "taskId": "task-1",
    "ownerPlannerId": "root-1",
    "title": "Task title",
    "description": "optional"
  }
}
```

Response: `{ "ok": true }`

#### `POST /v1/tasks/assign`
Request:

```json
{ "runId": "...", "taskId": "task-1", "agentId": "root-1" }
```

Response: `{ "ok": true }`

#### `POST /v1/tasks/status`
Request:

```json
{
  "runId": "...",
  "taskId": "task-1",
  "status": "in_progress",
  "note": "optional"
}
```

Response: `{ "ok": true }`

#### `POST /v1/agents/state`
Request:

```json
{
  "runId": "...",
  "agentId": "root-1",
  "state": "thinking",
  "note": "optional"
}
```

Response: `{ "ok": true }`

#### `POST /v1/handoffs/submit`
Request:

```json
{
  "runId": "...",
  "handoff": {
    "handoffId": "h1",
    "taskId": "task-1",
    "fromAgentId": "a1",
    "toAgentId": "a2",
    "summary": "...",
    "notes": "optional"
  }
}
```

Response: `{ "ok": true }`

#### `POST /v1/git/commit`
Request:

```json
{
  "runId": "...",
  "commit": {
    "sha": "abc123...",
    "parents": ["parentSha"],
    "branch": "main",
    "agentId": "a1",
    "taskId": "task-1",
    "message": "commit msg",
    "createdAt": 1730000000000,
    "stats": {
      "filesChanged": 2,
      "insertions": 10,
      "deletions": 3
    }
  },
  "diff": {
    "files": [
      { "path": "x.ts", "status": "modified", "patch": "@@ ..." }
    ],
    "unified": "diff --git ..."
  }
}
```

Response: `{ "ok": true }`

#### `POST /v1/git/branch`
Request:

```json
{ "runId": "...", "branch": "main", "sha": "abc123..." }
```

Response: `{ "ok": true }`

#### `POST /v1/tests/result`
Request:

```json
{
  "runId": "...",
  "sha": "abc123...",
  "suite": "integration",
  "ok": true,
  "durationMs": 1200,
  "output": "optional"
}
```

Response: `{ "ok": true }`

---

### 6) Live Stream (WebSocket)

#### `WS /v1/stream?runId=...`

Server messages:

```json
{ "type": "hello", "serverTime": 1730000000000 }
```

```json
{ "type": "event", "event": {/* EventEnvelope */} }
```

Client message:

```json
{ "type": "subscribe", "runId": "..." }
```

## Error Behavior

- Validation errors: HTTP `400`, body: `{ "error": "..." }`
- Missing run/diff: HTTP `404`, body: `{ "error": "..." }`
- Internal errors: HTTP `500`, body: `{ "error": "Internal server error" }` (or thrown message)

## Minimal End-to-End Manual Populate (CLI)

1. Create run: `POST /v1/runs`
2. Add root: `POST /v1/agents/create`
3. Add task: `POST /v1/tasks/create`
4. Assign/status: `POST /v1/tasks/assign`, `POST /v1/tasks/status`
5. Dashboard reads via `/v1/state`, `/v1/events`, and WS stream.

---

## Model-Readable Contract (JSON)

```json
{
  "name": "agent-swarm-mission-control-backend-contract",
  "version": "1.0",
  "baseUrl": "http://localhost:4000",
  "auth": "none",
  "contentType": "application/json",
  "timeFormat": "epoch_ms",
  "events": {
    "envelope": {
      "eventId": "string",
      "runId": "string",
      "ts": "number",
      "type": "enum",
      "payload": "object"
    },
    "types": [
      "agent.spawned",
      "agent.state_changed",
      "task.created",
      "task.assigned",
      "task.status_changed",
      "handoff.submitted",
      "tool.called",
      "tool.finished",
      "git.commit_created",
      "git.branch_updated",
      "tests.result"
    ]
  },
  "endpoints": [
    {
      "method": "POST",
      "path": "/v1/runs",
      "summary": "Create run",
      "request": { "name": "string" },
      "response": { "runId": "string" }
    },
    {
      "method": "GET",
      "path": "/v1/runs",
      "summary": "List runs",
      "response": {
        "runs": [
          { "runId": "string", "name": "string", "createdAt": "number" }
        ]
      }
    },
    {
      "method": "POST",
      "path": "/v1/events",
      "summary": "Append raw event envelopes",
      "request": { "runId": "string", "events": ["EventEnvelope"] },
      "response": { "ok": true, "inserted": "number" }
    },
    {
      "method": "GET",
      "path": "/v1/events",
      "query": { "runId": "string", "until": "number?" },
      "summary": "Query event log for replay",
      "response": { "events": ["EventEnvelope"] }
    },
    {
      "method": "GET",
      "path": "/v1/state",
      "query": { "runId": "string", "at": "number?" },
      "summary": "Derived snapshot",
      "response": {
        "at": "number",
        "agents": "record",
        "tasks": "record",
        "plannerTree": "object",
        "commits": "array",
        "branches": "array",
        "metrics": "object"
      }
    },
    {
      "method": "GET",
      "path": "/v1/diff/:sha",
      "query": { "runId": "string" },
      "summary": "Diff by sha",
      "response": {
        "sha": "string",
        "files": [
          { "path": "string", "status": "added|modified|deleted", "patch": "string" }
        ],
        "unified": "string"
      }
    },
    {
      "method": "POST",
      "path": "/v1/agents/create",
      "summary": "Emit agent.spawned",
      "request": {
        "runId": "string",
        "agent": {
          "agentId": "string",
          "role": "root_planner|planner|subplanner|worker",
          "parentAgentId": "string?",
          "name": "string?"
        }
      },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/tasks/create",
      "summary": "Emit task.created",
      "request": {
        "runId": "string",
        "task": {
          "taskId": "string",
          "ownerPlannerId": "string",
          "title": "string",
          "description": "string?"
        }
      },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/tasks/assign",
      "summary": "Emit task.assigned",
      "request": { "runId": "string", "taskId": "string", "agentId": "string" },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/tasks/status",
      "summary": "Emit task.status_changed",
      "request": {
        "runId": "string",
        "taskId": "string",
        "status": "backlog|in_progress|blocked|done|failed|retry",
        "note": "string?"
      },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/agents/state",
      "summary": "Emit agent.state_changed",
      "request": {
        "runId": "string",
        "agentId": "string",
        "state": "idle|thinking|running_tools|blocked|failed|done",
        "note": "string?"
      },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/handoffs/submit",
      "summary": "Emit handoff.submitted",
      "request": {
        "runId": "string",
        "handoff": {
          "handoffId": "string",
          "taskId": "string",
          "fromAgentId": "string",
          "toAgentId": "string",
          "summary": "string",
          "notes": "string?"
        }
      },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/git/commit",
      "summary": "Emit git.commit_created and store diff read model",
      "request": {
        "runId": "string",
        "commit": {
          "sha": "string",
          "parents": ["string"],
          "branch": "string?",
          "agentId": "string",
          "taskId": "string?",
          "message": "string",
          "createdAt": "number?",
          "stats": {
            "filesChanged": "number",
            "insertions": "number",
            "deletions": "number"
          }
        },
        "diff": {
          "files": [
            { "path": "string", "status": "added|modified|deleted", "patch": "string" }
          ],
          "unified": "string"
        }
      },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/git/branch",
      "summary": "Emit git.branch_updated",
      "request": { "runId": "string", "branch": "string", "sha": "string" },
      "response": { "ok": true }
    },
    {
      "method": "POST",
      "path": "/v1/tests/result",
      "summary": "Emit tests.result",
      "request": {
        "runId": "string",
        "sha": "string",
        "suite": "string",
        "ok": "boolean",
        "durationMs": "number",
        "output": "string?"
      },
      "response": { "ok": true }
    }
  ],
  "websocket": {
    "path": "/v1/stream",
    "query": { "runId": "string?" },
    "serverMessages": [
      { "type": "hello", "serverTime": "number" },
      { "type": "event", "event": "EventEnvelope" }
    ],
    "clientMessages": [
      { "type": "subscribe", "runId": "string" }
    ]
  },
  "errors": {
    "400": { "error": "validation message" },
    "404": { "error": "not found" },
    "500": { "error": "internal server error" }
  }
}
```
