# Agent Swarm Visualizer

Local-first, event-sourced dashboard for agent swarm runs.

- Backend: Fastify + SQLite + WebSocket stream
- Dashboard: Next.js App Router + TypeScript
- Dummy generator: deterministic seeded run simulator
- Shared package: contracts, event types, Zod schemas, derived-state reducer

## Repo Layout

- `backend` API server, SQLite store, WS stream, derived endpoints
- `dashboard` UI with planner tree, timeline/replay, commit DAG + diff viewer
- `dummy-swarm` seeded simulator that posts events through backend APIs
- `shared` TypeScript contract + reducer package

## Prerequisites

- Node.js 22+ (tested with Node 22 and 24)
- pnpm 10+

## Setup

1. Copy env:
   - `cp .env.example .env`
2. Install deps:
   - `pnpm install`

## Run (combined)

- Start backend + dashboard:
  - `pnpm dev`
- Start backend + dashboard and auto-seed demo data:
  - `pnpm demo`
- Seed a demo run:
  - `pnpm seed`
  - Default seed runs at `1x` for `60s` and spawns `20` agents in the planner tree.

## Run (one command per service)

- Backend only:
  - `pnpm dev:backend`
- Dashboard only:
  - `pnpm dev:dashboard`
- Dummy swarm only:
  - `pnpm --filter dummy-swarm dev -- --run-name "Demo Run" --seed 1 --speed 1 --duration 60`
  - The dummy swarm exercises convenience APIs (`/v1/agents/*`, `/v1/tasks/*`, `/v1/git/*`, `/v1/tests/result`) and uses `/v1/events` for tool-call events.

## URLs

- Dashboard: `http://localhost:3000`
- Backend API: `http://localhost:4000`
- WS stream: `ws://localhost:4000/v1/stream?runId=<RUN_ID>`

## Demo

1. `pnpm install`
2. `pnpm dev` (terminal A)
3. `pnpm seed` (terminal B)
4. Open `http://localhost:3000`
5. Watch live updates, then switch to **Replay** and scrub timeline

## Dummy Swarm Flags

- `--run-name` run name string
- `--seed` deterministic seed
- `--speed` replay acceleration (higher is faster)
- `--duration` simulated timeline duration in seconds
- `--base-time` optional base timestamp (epoch ms or ISO date)

Example:

```bash
pnpm --filter dummy-swarm dev -- --run-name "Treehacks Demo" --seed 42 --speed 30 --duration 120 --base-time "2026-02-14T18:00:00Z"
```

## API Contract

Detailed backend API contract (human + model-readable JSON):
- `docs/API_BACKEND_CONTRACT.md`

Implemented endpoints:

- `POST /v1/runs`
  - Creates a new run container and returns its `runId`.
- `GET /v1/runs`
  - Lists all runs (newest first) with `runId`, `name`, and `createdAt`.
- `POST /v1/events`
  - Appends one or more event envelopes to the immutable event log for a run.
- `GET /v1/events?runId=...&until=...`
  - Returns raw events for replay; `until` limits to events at/before a timestamp.
- `GET /v1/state?runId=...&at=...`
  - Returns derived snapshot state (agents, tasks, planner tree, commits, branches, metrics) at an optional point in time.
- `GET /v1/diff/:sha?runId=...`
  - Returns diff payload for a commit SHA (file patches + unified patch text).
- `POST /v1/agents/create`
  - Convenience endpoint that emits an `agent.spawned` event.
- `POST /v1/tasks/create`
  - Convenience endpoint that emits a `task.created` event.
- `POST /v1/tasks/assign`
  - Convenience endpoint that emits a `task.assigned` event.
- `POST /v1/tasks/status`
  - Convenience endpoint that emits a `task.status_changed` event.
- `POST /v1/agents/state`
  - Convenience endpoint that emits an `agent.state_changed` event.
- `POST /v1/handoffs/submit`
  - Convenience endpoint that emits a `handoff.submitted` event.
- `POST /v1/git/commit`
  - Convenience endpoint that emits `git.commit_created` and stores commit/diff read models.
- `POST /v1/git/branch`
  - Convenience endpoint that emits a `git.branch_updated` event.
- `POST /v1/tests/result`
  - Convenience endpoint that emits a `tests.result` event.
- `WS /v1/stream?runId=...`
  - Live event stream for a run. Sends `hello` first, then `event` frames as events are appended.

WS protocol:

- Server hello:
  - `{ "type": "hello", "serverTime": 1730000000000 }`
- Event frame:
  - `{ "type": "event", "event": EventEnvelope }`
- Client subscribe:
  - `{ "type": "subscribe", "runId": "..." }`

## Notes

- Backend always persists the append-only event log in SQLite.
- `commits`, `diffs`, and `tests` tables are maintained as convenience read models.
- `/v1/state` derives state from events via the shared pure reducer.
- Dashboard keeps an in-memory event cache for replay scrubbing.
