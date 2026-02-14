# Agent Swarm Visualizer Log API Contract

This document defines the log file format and the backend endpoint used to import logs for replay.

## High-Level Summary

- A **log file** is a portable run recording in `RunLogSpec` format.
- Each log event uses `offsetMs` (time from log base) plus typed `type + payload`.
- Importing a log appends converted `EventEnvelope` rows into the backend event store.
- Imported logs immediately drive all dashboard panes (planner tree, timeline/replay, commit DAG/diffs).
- Import can:
  - create a new run, or
  - append into an existing run via `runId`.

## Scope

- Endpoint: `POST /v1/logs/import`
- Source of truth in code:
  - `backend/src/server.ts`
  - `shared/src/types.ts`
  - `shared/src/schemas.ts`

## Endpoint (Human)

### `POST /v1/logs/import`

Imports a `RunLogSpec` and appends its events to a run.

Request body:

```json
{
  "runId": "optional-existing-run-id",
  "name": "optional-new-run-name",
  "baseTime": 1760000000000,
  "log": {
    "schemaVersion": "1.0",
    "name": "Optional Name In Log",
    "description": "Optional description",
    "baseTime": 1760000000000,
    "events": [
      {
        "eventId": "optional-event-id",
        "offsetMs": 0,
        "type": "agent.spawned",
        "payload": {
          "agentId": "agent-root",
          "role": "root_planner",
          "name": "Root"
        }
      }
    ]
  }
}
```

Response:

```json
{
  "ok": true,
  "runId": "generated-or-existing-run-id",
  "inserted": 1,
  "createdRun": true
}
```

Semantics:

- If `runId` is omitted, backend creates a run.
  - name priority: `request.name` -> `log.name` -> `"Imported Log"`.
- Event timestamp is computed as:
  - `effectiveBaseTime + event.offsetMs`
  - where `effectiveBaseTime` = `request.baseTime` -> `log.baseTime` -> `Date.now()`.
- `eventId` is optional in log file. If missing, backend generates UUID.

## Log File Spec (RunLogSpec)

```ts
type RunLogSpec = {
  schemaVersion: "1.0";
  name?: string;
  description?: string;
  baseTime?: number;
  events: Array<{
    eventId?: string;
    offsetMs: number;
    type:
      | "agent.spawned"
      | "agent.state_changed"
      | "task.created"
      | "task.assigned"
      | "task.status_changed"
      | "handoff.submitted"
      | "tool.called"
      | "tool.finished"
      | "git.commit_created"
      | "git.branch_updated"
      | "tests.result";
    payload: object;
  }>;
};
```

Payload shape for each `type` is exactly the same as the backend event payload contract in `docs/API_BACKEND_CONTRACT.md`.

## CLI Usage

Import the sample log:

```bash
pnpm seed:log -- --log-file dummy-swarm/logs/sample-log.v1.json --run-name "Uploaded Log Demo"
```

The sample file contains:

- 10 agents (`agent.spawned`)
- 20 commits (`git.commit_created`)
- branch updates, tests, tasks, and state changes

## Model Input Block

```json
{
  "log_api_version": "1.0",
  "endpoint": {
    "method": "POST",
    "path": "/v1/logs/import",
    "request": {
      "runId": "string?",
      "name": "string?",
      "baseTime": "number?",
      "log": {
        "schemaVersion": "1.0",
        "name": "string?",
        "description": "string?",
        "baseTime": "number?",
        "events": [
          {
            "eventId": "string?",
            "offsetMs": "number>=0",
            "type": "EventType",
            "payload": "EventPayload(type)"
          }
        ]
      }
    },
    "response": {
      "ok": true,
      "runId": "string",
      "inserted": "number",
      "createdRun": "boolean"
    }
  },
  "time_resolution_rule": {
    "effectiveBaseTime": "request.baseTime ?? log.baseTime ?? now()",
    "eventTimestamp": "effectiveBaseTime + offsetMs"
  }
}
```
