import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  agentCreateRequestSchema,
  agentStateRequestSchema,
  appendEventsRequestSchema,
  branchRequestSchema,
  commitRequestSchema,
  createRunRequestSchema,
  eventEnvelopeSchema,
  handoffRequestSchema,
  importLogRequestSchema,
  subscribeMessageSchema,
  taskAssignRequestSchema,
  taskCreateRequestSchema,
  taskStatusRequestSchema,
  testsRequestSchema,
  type AnyEventEnvelope,
  type EventPayloadMap,
  type EventType,
  type StreamServerMessage
} from "@agent-swarm-visualizer/shared";
import { z } from "zod";
import { config } from "./config";
import { createDatabase } from "./db";
import { AgentSwarmVisualizerStore } from "./store";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "warn"
  }
});
const db = createDatabase(config.dbPath);
const store = new AgentSwarmVisualizerStore(db);

const subscribers = new Map<any, string>();

await fastify.register(cors, {
  origin: true
});
await fastify.register(websocket);

function sendMessage(socket: any, message: StreamServerMessage): void {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(runId: string, events: AnyEventEnvelope[]): void {
  for (const [socket, subscribedRunId] of subscribers.entries()) {
    if (subscribedRunId !== runId) {
      continue;
    }
    for (const event of events) {
      sendMessage(socket, { type: "event", event });
    }
  }
}

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = new Error(parsed.error.issues.map((issue) => issue.message).join(", ")) as Error & {
      statusCode?: number;
    };
    error.statusCode = 400;
    throw error;
  }
  return parsed.data;
}

function ensureRunExists(runId: string): void {
  if (!store.hasRun(runId)) {
    const error = new Error(`Run not found: ${runId}`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
}

function makeEvent<T extends EventType>(runId: string, type: T, payload: EventPayloadMap[T], ts = Date.now()): AnyEventEnvelope {
  return {
    eventId: randomUUID(),
    runId,
    ts,
    type,
    payload
  } as AnyEventEnvelope;
}

const runIdQuerySchema = z.object({ runId: z.string().min(1) });
const eventsQuerySchema = z.object({
  runId: z.string().min(1),
  until: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    })
});

const stateQuerySchema = z.object({
  runId: z.string().min(1),
  at: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    })
});

fastify.post("/v1/runs", async (request, reply) => {
  const body = parseBody(createRunRequestSchema, request.body);
  const runId = store.createRun(body.name);
  return reply.send({ runId });
});

fastify.get("/v1/runs", async (_request, reply) => {
  return reply.send(store.listRuns());
});

fastify.post("/v1/events", async (request, reply) => {
  const body = parseBody(appendEventsRequestSchema, request.body);
  ensureRunExists(body.runId);

  const parsedEvents = body.events.map((event) => parseBody(eventEnvelopeSchema, event));
  for (const event of parsedEvents) {
    if (event.runId !== body.runId) {
      const error = new Error("Event runId must match request runId") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
  }

  const inserted = store.appendEvents(body.runId, parsedEvents);
  broadcast(body.runId, parsedEvents);
  return reply.send({ ok: true as const, inserted });
});

fastify.post("/v1/logs/import", async (request, reply) => {
  const body = parseBody(importLogRequestSchema, request.body);
  const runId = body.runId ?? store.createRun(body.name ?? body.log.name ?? "Imported Log");
  const createdRun = body.runId === undefined;
  if (!createdRun) {
    ensureRunExists(runId);
  }

  const baseTime = body.baseTime ?? body.log.baseTime ?? Date.now();
  const events: AnyEventEnvelope[] = body.log.events
    .map((record) => ({
      eventId: record.eventId ?? randomUUID(),
      runId,
      ts: baseTime + record.offsetMs,
      type: record.type,
      payload: record.payload
    }))
    .sort((a, b) => (a.ts === b.ts ? a.eventId.localeCompare(b.eventId) : a.ts - b.ts));

  const inserted = store.appendEvents(runId, events);
  broadcast(runId, events);
  return reply.send({ ok: true as const, runId, inserted, createdRun });
});

fastify.get("/v1/events", async (request, reply) => {
  const query = parseBody(eventsQuerySchema, request.query);
  ensureRunExists(query.runId);
  const events = store.getEvents(query.runId, query.until);
  return reply.send({ events });
});

fastify.get("/v1/state", async (request, reply) => {
  const query = parseBody(stateQuerySchema, request.query);
  ensureRunExists(query.runId);
  const state = store.getState(query.runId, query.at);
  return reply.send(state);
});

fastify.get("/v1/diff/:sha", async (request, reply) => {
  const params = parseBody(z.object({ sha: z.string().min(1) }), request.params);
  const query = parseBody(runIdQuerySchema, request.query);
  ensureRunExists(query.runId);
  const diff = store.getDiff(query.runId, params.sha);
  if (!diff) {
    const error = new Error(`Diff not found for sha ${params.sha}`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  return reply.send(diff);
});

fastify.post("/v1/agents/create", async (request, reply) => {
  const body = parseBody(agentCreateRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "agent.spawned", body.agent);
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/tasks/create", async (request, reply) => {
  const body = parseBody(taskCreateRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "task.created", body.task);
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/tasks/assign", async (request, reply) => {
  const body = parseBody(taskAssignRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "task.assigned", { taskId: body.taskId, agentId: body.agentId });
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/tasks/status", async (request, reply) => {
  const body = parseBody(taskStatusRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "task.status_changed", {
    taskId: body.taskId,
    status: body.status,
    note: body.note
  });
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/agents/state", async (request, reply) => {
  const body = parseBody(agentStateRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "agent.state_changed", {
    agentId: body.agentId,
    state: body.state,
    note: body.note
  });
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/handoffs/submit", async (request, reply) => {
  const body = parseBody(handoffRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "handoff.submitted", body.handoff);
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/git/commit", async (request, reply) => {
  const body = parseBody(commitRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "git.commit_created", {
    ...body.commit,
    diff: body.diff
  });
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/git/branch", async (request, reply) => {
  const body = parseBody(branchRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "git.branch_updated", {
    branch: body.branch,
    sha: body.sha
  });
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.post("/v1/tests/result", async (request, reply) => {
  const body = parseBody(testsRequestSchema, request.body);
  ensureRunExists(body.runId);
  const event = makeEvent(body.runId, "tests.result", {
    sha: body.sha,
    suite: body.suite,
    ok: body.ok,
    durationMs: body.durationMs,
    output: body.output
  });
  store.appendEvents(body.runId, [event]);
  broadcast(body.runId, [event]);
  return reply.send({ ok: true as const });
});

fastify.get(
  "/v1/stream",
  { websocket: true },
  (socket, request) => {
    sendMessage(socket, { type: "hello", serverTime: Date.now() });

    const queryResult = runIdQuerySchema.partial().safeParse(request.query);
    if (queryResult.success && queryResult.data.runId) {
      subscribers.set(socket, queryResult.data.runId);
    }

    socket.on("message", (raw: Buffer | string) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const parsedJson = JSON.parse(text) as unknown;
        const parsed = subscribeMessageSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return;
        }
        subscribers.set(socket, parsed.data.runId);
      } catch {
        return;
      }
    });

    socket.on("close", () => {
      subscribers.delete(socket);
    });
  }
);

fastify.setErrorHandler((error, _request, reply) => {
  const statusCode = (error as any).statusCode ?? 500;
  const message = error.message || "Internal server error";
  reply.status(statusCode).send({ error: message });
});

const start = async () => {
  try {
    await fastify.listen({ port: config.backendPort, host: "0.0.0.0" });
    fastify.log.info(`Backend listening on http://localhost:${config.backendPort}`);
    fastify.log.info(`Using SQLite at ${config.dbPath}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
};

await start();
