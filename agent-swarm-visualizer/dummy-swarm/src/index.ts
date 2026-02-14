import minimist from "minimist";
import seedrandom from "seedrandom";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";
import type {
  AnyEventEnvelope,
  CommitStats,
  DiffFile,
  EventPayloadMap,
  EventType,
  GitCommitCreatedPayload
} from "@agent-swarm-visualizer/shared";

const BASE_TIMELINE_MS = 60_000;

function readEnvValue(key: string): string | undefined {
  const direct = process.env[key];
  if (direct && direct.length > 0) {
    return direct;
  }

  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../.env")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const content = fs.readFileSync(candidate, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const index = line.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const envKey = line.slice(0, index).trim();
      if (envKey !== key) {
        continue;
      }
      const envValue = line
        .slice(index + 1)
        .trim()
        .replace(/^['"]/, "")
        .replace(/['"]$/, "");
      if (envValue.length > 0) {
        return envValue;
      }
    }
  }

  return undefined;
}

function resolveBackendUrl(): string {
  const explicit =
    readEnvValue("BACKEND_URL") ?? readEnvValue("DASHBOARD_BACKEND_URL") ?? readEnvValue("NEXT_PUBLIC_BACKEND_URL");
  if (explicit) {
    return explicit;
  }

  const port = readEnvValue("BACKEND_PORT");
  if (port) {
    return `http://localhost:${port}`;
  }

  return "http://localhost:4000";
}

function resolveBackendCandidates(): string[] {
  const base = resolveBackendUrl();
  const candidates = new Set<string>([base]);

  try {
    const url = new URL(base);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      candidates.add(url.toString().replace(/\/$/, ""));
    }
  } catch {
    // Ignore malformed override; it'll fail in requests with a useful error.
  }

  return [...candidates];
}

const BACKEND_CANDIDATES = resolveBackendCandidates();
let ACTIVE_BACKEND_URL = BACKEND_CANDIDATES[0];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function parseBaseTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function deterministicUuid(rng: seedrandom.PRNG): string {
  const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return template.replace(/[xy]/g, (char) => {
    const n = Math.floor(rng() * 16);
    const value = char === "x" ? n : (n & 0x3) | 0x8;
    return value.toString(16);
  });
}

function deterministicSha(rng: seedrandom.PRNG): string {
  let sha = "";
  for (let i = 0; i < 40; i += 1) {
    sha += Math.floor(rng() * 16).toString(16);
  }
  return sha;
}

function buildUnified(files: DiffFile[]): string {
  return files
    .map((file) => `diff --git a/${file.path} b/${file.path}\n${file.patch}`)
    .join("\n\n");
}

function buildStats(files: DiffFile[]): CommitStats {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const line of file.patch.split("\n")) {
      if (line.startsWith("+++")) {
        continue;
      }
      if (line.startsWith("---")) {
        continue;
      }
      if (line.startsWith("+")) {
        insertions += 1;
      }
      if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return {
    filesChanged: files.length,
    insertions,
    deletions
  };
}

function makeDiffs(): Record<string, { files: DiffFile[]; unified: string; stats: CommitStats }> {
  const commitOneFiles: DiffFile[] = [
    {
      path: "backend/src/routes/events.ts",
      status: "added",
      patch: [
        "--- /dev/null",
        "+++ b/backend/src/routes/events.ts",
        "@@ -0,0 +1,7 @@",
        "+import { fastify } from '../server';",
        "+",
        "+export function registerEventRoutes() {",
        "+  fastify.post('/v1/events', async () => ({ ok: true }));",
        "+}",
        "+"
      ].join("\n")
    },
    {
      path: "shared/src/types.ts",
      status: "modified",
      patch: [
        "--- a/shared/src/types.ts",
        "+++ b/shared/src/types.ts",
        "@@ -1,3 +1,5 @@",
        " export type EventType = string;",
        "+export interface EventEnvelope {",
        "+  eventId: string;",
        "+}",
        ""
      ].join("\n")
    }
  ];

  const commitTwoFiles: DiffFile[] = [
    {
      path: "dashboard/components/planner-tree-pane.tsx",
      status: "added",
      patch: [
        "--- /dev/null",
        "+++ b/dashboard/components/planner-tree-pane.tsx",
        "@@ -0,0 +1,8 @@",
        "+export function PlannerTreePane() {",
        "+  return (",
        "+    <section>",
        "+      <h2>Planner Tree</h2>",
        "+    </section>",
        "+  );",
        "+}",
        "+"
      ].join("\n")
    },
    {
      path: "dashboard/app/globals.css",
      status: "modified",
      patch: [
        "--- a/dashboard/app/globals.css",
        "+++ b/dashboard/app/globals.css",
        "@@ -9,2 +9,4 @@",
        " .pane-grid {",
        "-  display: block;",
        "+  display: grid;",
        "+  grid-template-columns: 1fr 1fr;",
        " }",
        ""
      ].join("\n")
    }
  ];

  const commitThreeFiles: DiffFile[] = [
    {
      path: "backend/src/server.ts",
      status: "modified",
      patch: [
        "--- a/backend/src/server.ts",
        "+++ b/backend/src/server.ts",
        "@@ -42,3 +42,8 @@",
        " app.get('/health', () => ({ ok: true }));",
        "+app.get('/v1/stream', { websocket: true }, (socket) => {",
        "+  socket.send(JSON.stringify({ type: 'hello' }));",
        "+});",
        "+",
        "+function broadcast() {}",
        ""
      ].join("\n")
    },
    {
      path: "backend/src/store.ts",
      status: "modified",
      patch: [
        "--- a/backend/src/store.ts",
        "+++ b/backend/src/store.ts",
        "@@ -11,3 +11,6 @@",
        " export class Store {",
        "+  append(event) {",
        "+    return this.db.insert(event);",
        "+  }",
        " }",
        ""
      ].join("\n")
    }
  ];

  const mergeFiles: DiffFile[] = [
    {
      path: "dashboard/components/agent-swarm-visualizer.tsx",
      status: "modified",
      patch: [
        "--- a/dashboard/components/agent-swarm-visualizer.tsx",
        "+++ b/dashboard/components/agent-swarm-visualizer.tsx",
        "@@ -18,4 +18,6 @@",
        " import { PlannerTreePane } from './planner-tree-pane';",
        "+import { connectStream } from '../lib/api';",
        "+import { CommitPane } from './commit-pane';",
        "",
        " export function AgentSwarmVisualizer() {",
        ""
      ].join("\n")
    },
    {
      path: "dashboard/lib/api.ts",
      status: "modified",
      patch: [
        "--- a/dashboard/lib/api.ts",
        "+++ b/dashboard/lib/api.ts",
        "@@ -31,3 +31,7 @@",
        " export async function getEvents() {}",
        "+export function connectStream(runId) {",
        "+  return new WebSocket(`/v1/stream?runId=${runId}`);",
        "+}",
        "+",
        ""
      ].join("\n")
    }
  ];

  const finalFiles: DiffFile[] = [
    {
      path: "README.md",
      status: "modified",
      patch: [
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1,3 +1,8 @@",
        " # Agent Swarm Visualizer",
        "+",
        "+## Demo",
        "+1. pnpm install",
        "+2. pnpm dev",
        "+3. pnpm seed",
        "+",
        ""
      ].join("\n")
    }
  ];

  const groups = {
    c1: commitOneFiles,
    c2: commitTwoFiles,
    c3: commitThreeFiles,
    c4: mergeFiles,
    c5: finalFiles
  };

  return Object.fromEntries(
    Object.entries(groups).map(([name, files]) => [
      name,
      {
        files,
        unified: buildUnified(files),
        stats: buildStats(files)
      }
    ])
  );
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ACTIVE_BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${path} (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

async function waitForBackend(maxAttempts = 60, intervalMs = 500): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const candidate of BACKEND_CANDIDATES) {
      try {
        const response = await fetch(`${candidate}/v1/runs`, {
          method: "GET"
        });
        if (response.ok) {
          ACTIVE_BACKEND_URL = candidate;
          return;
        }
      } catch {
        // Retry until timeout.
      }
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Backend is not reachable. Tried: ${BACKEND_CANDIDATES.join(", ")}. Start backend first (pnpm dev) and verify its port.`
  );
}

function getCliArgv(): string[] {
  const argv = process.argv.slice(2);
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return argv;
  }
  return argv.slice(separatorIndex + 1);
}

async function appendEvent(runId: string, event: AnyEventEnvelope): Promise<void> {
  await postJson<{ ok: true; inserted: number }>("/v1/events", {
    runId,
    events: [event]
  });
}

async function emitEvent(runId: string, event: AnyEventEnvelope): Promise<string> {
  switch (event.type) {
    case "agent.spawned":
      await postJson<{ ok: true }>("/v1/agents/create", {
        runId,
        agent: event.payload
      });
      return "/v1/agents/create";
    case "task.created":
      await postJson<{ ok: true }>("/v1/tasks/create", {
        runId,
        task: event.payload
      });
      return "/v1/tasks/create";
    case "task.assigned":
      await postJson<{ ok: true }>("/v1/tasks/assign", {
        runId,
        taskId: event.payload.taskId,
        agentId: event.payload.agentId
      });
      return "/v1/tasks/assign";
    case "task.status_changed":
      await postJson<{ ok: true }>("/v1/tasks/status", {
        runId,
        taskId: event.payload.taskId,
        status: event.payload.status,
        note: event.payload.note
      });
      return "/v1/tasks/status";
    case "agent.state_changed":
      await postJson<{ ok: true }>("/v1/agents/state", {
        runId,
        agentId: event.payload.agentId,
        state: event.payload.state,
        note: event.payload.note
      });
      return "/v1/agents/state";
    case "handoff.submitted":
      await postJson<{ ok: true }>("/v1/handoffs/submit", {
        runId,
        handoff: event.payload
      });
      return "/v1/handoffs/submit";
    case "git.commit_created": {
      if (!event.payload.diff) {
        throw new Error(`git.commit_created payload for ${event.payload.sha} is missing diff`);
      }
      const { diff, ...commit } = event.payload;
      await postJson<{ ok: true }>("/v1/git/commit", {
        runId,
        commit: {
          ...commit,
          createdAt: commit.createdAt ?? event.ts
        },
        diff
      });
      return "/v1/git/commit";
    }
    case "git.branch_updated":
      await postJson<{ ok: true }>("/v1/git/branch", {
        runId,
        branch: event.payload.branch,
        sha: event.payload.sha
      });
      return "/v1/git/branch";
    case "tests.result":
      await postJson<{ ok: true }>("/v1/tests/result", {
        runId,
        sha: event.payload.sha,
        suite: event.payload.suite,
        ok: event.payload.ok,
        durationMs: event.payload.durationMs,
        output: event.payload.output
      });
      return "/v1/tests/result";
    case "tool.called":
    case "tool.finished":
      await appendEvent(runId, event);
      return "/v1/events";
    default:
      await appendEvent(runId, event);
      return "/v1/events";
  }
}

async function main() {
  const args = minimist(getCliArgv(), {
    string: ["run-name", "base-time"],
    default: {
      seed: 1,
      speed: 1,
      duration: 60
    }
  });

  const runName = String(args["run-name"] ?? "Demo Run");
  const seed = Number(args.seed ?? 1);
  const speed = Math.max(0.1, Number(args.speed ?? 1));
  const durationSeconds = Math.max(10, Number(args.duration ?? 60));
  const durationMs = durationSeconds * 1000;
  const baseTime = parseBaseTime(args["base-time"]);

  const rng = seedrandom(String(seed));

  console.log(`[dummy-swarm] backend candidates=${BACKEND_CANDIDATES.join(", ")}`);
  await waitForBackend();
  console.log(`[dummy-swarm] backend selected=${ACTIVE_BACKEND_URL}`);

  const runResponse = await postJson<{ runId: string }>("/v1/runs", { name: runName });
  const runId = runResponse.runId;

  const root = "agent-root";
  const plannerA = "agent-planner-a";
  const plannerB = "agent-planner-b";
  const worker1 = "agent-worker-1";
  const worker2 = "agent-worker-2";
  const worker3 = "agent-worker-3";
  const subA1 = "agent-subplanner-a1";
  const subA2 = "agent-subplanner-a2";
  const subB1 = "agent-subplanner-b1";
  const subB2 = "agent-subplanner-b2";
  const workerA1a = "agent-worker-a1a";
  const workerA1b = "agent-worker-a1b";
  const workerA2a = "agent-worker-a2a";
  const workerA2b = "agent-worker-a2b";
  const workerB1a = "agent-worker-b1a";
  const workerB1b = "agent-worker-b1b";
  const workerB2a = "agent-worker-b2a";
  const workerB2b = "agent-worker-b2b";
  const workerOps = "agent-worker-ops";
  const workerDocs = "agent-worker-docs";

  const taskPlan = "task-plan";
  const taskApi = "task-api";
  const taskUi = "task-ui";
  const taskReplay = "task-replay";
  const taskMerge = "task-merge";

  const sha1 = deterministicSha(rng);
  const sha2 = deterministicSha(rng);
  const sha3 = deterministicSha(rng);
  const sha4 = deterministicSha(rng);
  const sha5 = deterministicSha(rng);

  const diffMap = makeDiffs();

  type Scheduled = {
    offset: number;
    type: EventType;
    payload: EventPayloadMap[EventType];
  };

  const extraAgents = [
    { agentId: subA1, role: "subplanner", parentAgentId: plannerA, name: "Subplanner A1" },
    { agentId: subA2, role: "subplanner", parentAgentId: plannerA, name: "Subplanner A2" },
    { agentId: subB1, role: "subplanner", parentAgentId: plannerB, name: "Subplanner B1" },
    { agentId: subB2, role: "subplanner", parentAgentId: plannerB, name: "Subplanner B2" },
    { agentId: workerA1a, role: "worker", parentAgentId: subA1, name: "Worker A1A" },
    { agentId: workerA1b, role: "worker", parentAgentId: subA1, name: "Worker A1B" },
    { agentId: workerA2a, role: "worker", parentAgentId: subA2, name: "Worker A2A" },
    { agentId: workerA2b, role: "worker", parentAgentId: subA2, name: "Worker A2B" },
    { agentId: workerB1a, role: "worker", parentAgentId: subB1, name: "Worker B1A" },
    { agentId: workerB1b, role: "worker", parentAgentId: subB1, name: "Worker B1B" },
    { agentId: workerB2a, role: "worker", parentAgentId: subB2, name: "Worker B2A" },
    { agentId: workerB2b, role: "worker", parentAgentId: subB2, name: "Worker B2B" },
    { agentId: workerOps, role: "worker", parentAgentId: root, name: "Ops Worker" },
    { agentId: workerDocs, role: "worker", parentAgentId: root, name: "Docs Worker" }
  ] as const;

  const extraSpawnEvents: Scheduled[] = extraAgents.map((agent, index) => ({
    offset: 7600 + index * 680,
    type: "agent.spawned",
    payload: { ...agent }
  }));

  const extraTaskSpecs = [
    { taskId: "task-ui-polish", ownerPlannerId: subA1, agentId: workerA1a, title: "UI polish pass" },
    { taskId: "task-ui-a11y", ownerPlannerId: subA1, agentId: workerA1b, title: "Accessibility audit" },
    { taskId: "task-api-auth", ownerPlannerId: subA2, agentId: workerA2a, title: "Auth middleware hardening" },
    { taskId: "task-api-cache", ownerPlannerId: subA2, agentId: workerA2b, title: "Cache layer tuning" },
    { taskId: "task-tests-unit", ownerPlannerId: subB1, agentId: workerB1a, title: "Unit test expansion" },
    { taskId: "task-tests-e2e", ownerPlannerId: subB1, agentId: workerB1b, title: "E2E smoke suite" },
    { taskId: "task-docs-api", ownerPlannerId: subB2, agentId: workerB2a, title: "API docs update" },
    { taskId: "task-infra-alerts", ownerPlannerId: subB2, agentId: workerB2b, title: "Alerting policy setup" },
    { taskId: "task-ops-dash", ownerPlannerId: root, agentId: workerOps, title: "Ops dashboard checks" },
    { taskId: "task-release-notes", ownerPlannerId: root, agentId: workerDocs, title: "Release notes draft" }
  ] as const;

  const extraTaskEvents: Scheduled[] = extraTaskSpecs.flatMap((task, index) => {
    const start = 18_000 + index * 1_450;
    return [
      {
        offset: start,
        type: "task.created",
        payload: {
          taskId: task.taskId,
          ownerPlannerId: task.ownerPlannerId,
          title: task.title
        }
      },
      {
        offset: start + 260,
        type: "task.assigned",
        payload: {
          taskId: task.taskId,
          agentId: task.agentId
        }
      },
      {
        offset: start + 620,
        type: "task.status_changed",
        payload: {
          taskId: task.taskId,
          status: "in_progress"
        }
      },
      {
        offset: 45_500 + index * 820,
        type: "task.status_changed",
        payload: {
          taskId: task.taskId,
          status: "done"
        }
      },
      {
        offset: 55_000 + index * 240,
        type: "agent.state_changed",
        payload: {
          agentId: task.agentId,
          state: "done"
        }
      }
    ];
  });

  const schedule: Scheduled[] = [
    { offset: 0, type: "agent.spawned", payload: { agentId: root, role: "root_planner", name: "Root Planner" } },
    { offset: 1500, type: "agent.state_changed", payload: { agentId: root, state: "thinking", note: "Bootstrapping mission plan" } },
    { offset: 2500, type: "task.created", payload: { taskId: taskPlan, ownerPlannerId: root, title: "Plan mission", description: "Define architecture lanes" } },
    { offset: 3000, type: "task.assigned", payload: { taskId: taskPlan, agentId: root } },
    { offset: 3600, type: "task.status_changed", payload: { taskId: taskPlan, status: "in_progress" } },
    { offset: 4700, type: "agent.spawned", payload: { agentId: plannerA, role: "planner", parentAgentId: root, name: "Planner A" } },
    { offset: 5200, type: "agent.spawned", payload: { agentId: plannerB, role: "subplanner", parentAgentId: root, name: "Planner B" } },
    { offset: 6200, type: "agent.spawned", payload: { agentId: worker1, role: "worker", parentAgentId: plannerA, name: "Worker UI" } },
    { offset: 6600, type: "agent.spawned", payload: { agentId: worker2, role: "worker", parentAgentId: plannerA, name: "Worker API" } },
    { offset: 7100, type: "agent.spawned", payload: { agentId: worker3, role: "worker", parentAgentId: plannerB, name: "Worker Tests" } },
    ...extraSpawnEvents,
    { offset: 8200, type: "task.created", payload: { taskId: taskApi, ownerPlannerId: plannerB, title: "Backend event APIs" } },
    { offset: 8500, type: "task.created", payload: { taskId: taskUi, ownerPlannerId: plannerA, title: "Tree + timeline UI" } },
    { offset: 9000, type: "task.assigned", payload: { taskId: taskApi, agentId: worker2 } },
    { offset: 9400, type: "task.assigned", payload: { taskId: taskUi, agentId: worker1 } },
    { offset: 9800, type: "task.status_changed", payload: { taskId: taskApi, status: "in_progress" } },
    { offset: 10_500, type: "task.status_changed", payload: { taskId: taskUi, status: "in_progress" } },
    { offset: 11_400, type: "tool.called", payload: { toolCallId: "tool-db-init", agentId: worker2, taskId: taskApi, tool: "sqlite.migrate", inputSummary: "Create event store schema" } },
    { offset: 13_200, type: "tool.finished", payload: { toolCallId: "tool-db-init", agentId: worker2, taskId: taskApi, ok: true, durationMs: 1800, outputSummary: "Schema created" } },
    {
      offset: 14_700,
      type: "git.commit_created",
      payload: {
        sha: sha1,
        parents: [],
        branch: "main",
        agentId: worker2,
        taskId: taskApi,
        message: "feat: bootstrap event endpoints",
        stats: diffMap.c1.stats,
        diff: { files: diffMap.c1.files, unified: diffMap.c1.unified }
      } satisfies GitCommitCreatedPayload
    },
    { offset: 14_900, type: "git.branch_updated", payload: { branch: "main", sha: sha1 } },
    { offset: 15_500, type: "tests.result", payload: { sha: sha1, suite: "backend-api", ok: true, durationMs: 1360, output: "12 passed" } },
    { offset: 16_200, type: "task.status_changed", payload: { taskId: taskApi, status: "done" } },
    { offset: 17_000, type: "tool.called", payload: { toolCallId: "tool-ui-layout", agentId: worker1, taskId: taskUi, tool: "ui.render", inputSummary: "Implement tree + lanes" } },
    { offset: 20_500, type: "tool.finished", payload: { toolCallId: "tool-ui-layout", agentId: worker1, taskId: taskUi, ok: false, durationMs: 3500, outputSummary: "Layout jitter at small screens" } },
    { offset: 21_100, type: "task.status_changed", payload: { taskId: taskUi, status: "failed", note: "SVG layout overflow" } },
    { offset: 22_300, type: "task.status_changed", payload: { taskId: taskUi, status: "retry", note: "Retry with responsive viewBox" } },
    { offset: 23_000, type: "tool.called", payload: { toolCallId: "tool-ui-layout-retry", agentId: worker1, taskId: taskUi, tool: "ui.render", inputSummary: "Apply responsive bounds" } },
    { offset: 25_000, type: "tool.finished", payload: { toolCallId: "tool-ui-layout-retry", agentId: worker1, taskId: taskUi, ok: true, durationMs: 2000, outputSummary: "Responsive fix merged" } },
    {
      offset: 25_800,
      type: "git.commit_created",
      payload: {
        sha: sha2,
        parents: [sha1],
        branch: "feature/ui",
        agentId: worker1,
        taskId: taskUi,
        message: "feat: render planner tree and timeline panes",
        stats: diffMap.c2.stats,
        diff: { files: diffMap.c2.files, unified: diffMap.c2.unified }
      } satisfies GitCommitCreatedPayload
    },
    { offset: 26_100, type: "git.branch_updated", payload: { branch: "feature/ui", sha: sha2 } },
    { offset: 26_800, type: "tests.result", payload: { sha: sha2, suite: "dashboard-ui", ok: false, durationMs: 2500, output: "1 failed: timeline zoom lane clipping" } },
    { offset: 27_900, type: "task.status_changed", payload: { taskId: taskUi, status: "done" } },
    { offset: 29_000, type: "task.created", payload: { taskId: taskReplay, ownerPlannerId: plannerB, title: "Replay scrubber controls" } },
    { offset: 29_500, type: "task.assigned", payload: { taskId: taskReplay, agentId: worker3 } },
    { offset: 30_000, type: "task.status_changed", payload: { taskId: taskReplay, status: "in_progress" } },
    { offset: 31_000, type: "handoff.submitted", payload: { handoffId: "handoff-1", taskId: taskReplay, fromAgentId: plannerB, toAgentId: worker3, summary: "Wire replay slider to event reducer" } },
    { offset: 32_000, type: "tool.called", payload: { toolCallId: "tool-stream", agentId: worker3, taskId: taskReplay, tool: "ws.connect", inputSummary: "Subscribe to /v1/stream" } },
    { offset: 33_000, type: "tool.finished", payload: { toolCallId: "tool-stream", agentId: worker3, taskId: taskReplay, ok: true, durationMs: 1000, outputSummary: "Connected with hello + event frames" } },
    {
      offset: 34_000,
      type: "git.commit_created",
      payload: {
        sha: sha3,
        parents: [sha1],
        branch: "main",
        agentId: worker3,
        taskId: taskReplay,
        message: "feat: websocket stream and replay state",
        stats: diffMap.c3.stats,
        diff: { files: diffMap.c3.files, unified: diffMap.c3.unified }
      } satisfies GitCommitCreatedPayload
    },
    { offset: 34_400, type: "git.branch_updated", payload: { branch: "main", sha: sha3 } },
    { offset: 35_200, type: "tests.result", payload: { sha: sha3, suite: "streaming", ok: true, durationMs: 1100, output: "stream handshake ok" } },
    { offset: 36_500, type: "task.status_changed", payload: { taskId: taskReplay, status: "done" } },
    { offset: 38_000, type: "task.created", payload: { taskId: taskMerge, ownerPlannerId: root, title: "Merge UI + backend tracks" } },
    { offset: 39_000, type: "task.assigned", payload: { taskId: taskMerge, agentId: plannerB } },
    { offset: 39_800, type: "task.status_changed", payload: { taskId: taskMerge, status: "in_progress" } },
    {
      offset: 41_000,
      type: "git.commit_created",
      payload: {
        sha: sha4,
        parents: [sha3, sha2],
        branch: "main",
        agentId: plannerB,
        taskId: taskMerge,
        message: "merge: integrate ui lanes with live stream",
        stats: diffMap.c4.stats,
        diff: { files: diffMap.c4.files, unified: diffMap.c4.unified }
      } satisfies GitCommitCreatedPayload
    },
    { offset: 41_300, type: "git.branch_updated", payload: { branch: "main", sha: sha4 } },
    { offset: 42_300, type: "tests.result", payload: { sha: sha4, suite: "integration", ok: true, durationMs: 2900, output: "all green after merge" } },
    { offset: 43_500, type: "task.status_changed", payload: { taskId: taskMerge, status: "done" } },
    {
      offset: 47_000,
      type: "git.commit_created",
      payload: {
        sha: sha5,
        parents: [sha4],
        branch: "main",
        agentId: worker1,
        message: "docs: add visualizer demo steps",
        stats: diffMap.c5.stats,
        diff: { files: diffMap.c5.files, unified: diffMap.c5.unified }
      } satisfies GitCommitCreatedPayload
    },
    { offset: 47_200, type: "git.branch_updated", payload: { branch: "main", sha: sha5 } },
    { offset: 48_100, type: "tests.result", payload: { sha: sha5, suite: "smoke", ok: true, durationMs: 430, output: "dashboard starts" } },
    ...extraTaskEvents,
    { offset: 57_200, type: "task.status_changed", payload: { taskId: taskPlan, status: "done" } },
    { offset: 57_600, type: "agent.state_changed", payload: { agentId: worker1, state: "done" } },
    { offset: 57_800, type: "agent.state_changed", payload: { agentId: worker2, state: "done" } },
    { offset: 58_000, type: "agent.state_changed", payload: { agentId: worker3, state: "done" } },
    { offset: 58_400, type: "agent.state_changed", payload: { agentId: plannerA, state: "done" } },
    { offset: 58_700, type: "agent.state_changed", payload: { agentId: plannerB, state: "done" } },
    { offset: 59_500, type: "agent.state_changed", payload: { agentId: root, state: "done", note: "Mission complete" } }
  ];

  const scale = durationMs / BASE_TIMELINE_MS;

  const events: AnyEventEnvelope[] = schedule
    .map((item) => ({
      eventId: deterministicUuid(rng),
      runId,
      ts: Math.round(baseTime + item.offset * scale),
      type: item.type,
      payload: item.payload
    }) as AnyEventEnvelope)
    .sort((a, b) => (a.ts === b.ts ? a.eventId.localeCompare(b.eventId) : a.ts - b.ts));

  const spawnedAgentCount = new Set(
    events
      .filter((event) => event.type === "agent.spawned")
      .map((event) => event.payload.agentId)
  ).size;

  console.log(`[dummy-swarm] runId=${runId} name=${runName}`);
  console.log(
    `[dummy-swarm] events=${events.length} seed=${seed} speed=${speed} duration=${durationSeconds}s agents=${spawnedAgentCount}`
  );

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1];
    if (previous) {
      const waitMs = (event.ts - previous.ts) / speed;
      await sleep(waitMs);
    }

    const endpoint = await emitEvent(runId, event);
    console.log(`[dummy-swarm] ${new Date(event.ts).toISOString()} ${event.type} -> ${endpoint}`);
  }

  console.log("[dummy-swarm] completed");
}

main().catch((error) => {
  console.error("[dummy-swarm] failed", error);
  process.exit(1);
});
