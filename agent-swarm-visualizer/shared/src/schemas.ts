import { z } from "zod";

export const agentRoleSchema = z.enum(["root_planner", "planner", "subplanner", "worker"]);
export const agentRuntimeStateSchema = z.enum(["idle", "thinking", "running_tools", "blocked", "failed", "done"]);
export const taskStatusSchema = z.enum(["backlog", "in_progress", "blocked", "done", "failed", "retry"]);
export const diffFileStatusSchema = z.enum(["added", "modified", "deleted"]);

export const diffFileSchema = z.object({
  path: z.string().min(1),
  status: diffFileStatusSchema,
  patch: z.string()
});

export const diffPayloadSchema = z.object({
  files: z.array(diffFileSchema),
  unified: z.string()
});

export const commitStatsSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative()
});

export const agentSpawnedPayloadSchema = z.object({
  agentId: z.string().min(1),
  role: agentRoleSchema,
  parentAgentId: z.string().min(1).optional(),
  name: z.string().min(1).optional()
});

export const agentStateChangedPayloadSchema = z.object({
  agentId: z.string().min(1),
  state: agentRuntimeStateSchema,
  note: z.string().optional()
});

export const taskCreatedPayloadSchema = z.object({
  taskId: z.string().min(1),
  ownerPlannerId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional()
});

export const taskAssignedPayloadSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1)
});

export const taskStatusChangedPayloadSchema = z.object({
  taskId: z.string().min(1),
  status: taskStatusSchema,
  note: z.string().optional()
});

export const handoffSubmittedPayloadSchema = z.object({
  handoffId: z.string().min(1),
  taskId: z.string().min(1),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  summary: z.string().min(1),
  notes: z.string().optional()
});

export const toolCalledPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  agentId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  tool: z.string().min(1),
  inputSummary: z.string().optional()
});

export const toolFinishedPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  agentId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  ok: z.boolean(),
  outputSummary: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional()
});

export const gitCommitCreatedPayloadSchema = z.object({
  sha: z.string().min(1),
  parents: z.array(z.string().min(1)),
  branch: z.string().min(1).optional(),
  agentId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  message: z.string().min(1),
  createdAt: z.number().int().nonnegative().optional(),
  stats: commitStatsSchema.optional(),
  diff: diffPayloadSchema.optional()
});

export const gitBranchUpdatedPayloadSchema = z.object({
  branch: z.string().min(1),
  sha: z.string().min(1)
});

export const testsResultPayloadSchema = z.object({
  sha: z.string().min(1),
  suite: z.string().min(1),
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  output: z.string().optional()
});

const eventByTypeSchema = {
  "agent.spawned": z.object({ type: z.literal("agent.spawned"), payload: agentSpawnedPayloadSchema }),
  "agent.state_changed": z.object({ type: z.literal("agent.state_changed"), payload: agentStateChangedPayloadSchema }),
  "task.created": z.object({ type: z.literal("task.created"), payload: taskCreatedPayloadSchema }),
  "task.assigned": z.object({ type: z.literal("task.assigned"), payload: taskAssignedPayloadSchema }),
  "task.status_changed": z.object({ type: z.literal("task.status_changed"), payload: taskStatusChangedPayloadSchema }),
  "handoff.submitted": z.object({ type: z.literal("handoff.submitted"), payload: handoffSubmittedPayloadSchema }),
  "tool.called": z.object({ type: z.literal("tool.called"), payload: toolCalledPayloadSchema }),
  "tool.finished": z.object({ type: z.literal("tool.finished"), payload: toolFinishedPayloadSchema }),
  "git.commit_created": z.object({ type: z.literal("git.commit_created"), payload: gitCommitCreatedPayloadSchema }),
  "git.branch_updated": z.object({ type: z.literal("git.branch_updated"), payload: gitBranchUpdatedPayloadSchema }),
  "tests.result": z.object({ type: z.literal("tests.result"), payload: testsResultPayloadSchema })
};

const eventUnionSchema = z.discriminatedUnion("type", [
  eventByTypeSchema["agent.spawned"],
  eventByTypeSchema["agent.state_changed"],
  eventByTypeSchema["task.created"],
  eventByTypeSchema["task.assigned"],
  eventByTypeSchema["task.status_changed"],
  eventByTypeSchema["handoff.submitted"],
  eventByTypeSchema["tool.called"],
  eventByTypeSchema["tool.finished"],
  eventByTypeSchema["git.commit_created"],
  eventByTypeSchema["git.branch_updated"],
  eventByTypeSchema["tests.result"]
]);

export const eventEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    runId: z.string().min(1),
    ts: z.number().int().nonnegative()
  })
  .and(eventUnionSchema);

export const createRunRequestSchema = z.object({
  name: z.string().min(1)
});

export const appendEventsRequestSchema = z.object({
  runId: z.string().min(1),
  events: z.array(eventEnvelopeSchema)
});

export const agentCreateRequestSchema = z.object({
  runId: z.string().min(1),
  agent: agentSpawnedPayloadSchema
});

export const taskCreateRequestSchema = z.object({
  runId: z.string().min(1),
  task: taskCreatedPayloadSchema
});

export const taskAssignRequestSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1)
});

export const taskStatusRequestSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  status: taskStatusSchema,
  note: z.string().optional()
});

export const agentStateRequestSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
  state: agentRuntimeStateSchema,
  note: z.string().optional()
});

export const handoffRequestSchema = z.object({
  runId: z.string().min(1),
  handoff: handoffSubmittedPayloadSchema
});

export const commitRequestSchema = z.object({
  runId: z.string().min(1),
  commit: gitCommitCreatedPayloadSchema.omit({ diff: true }),
  diff: diffPayloadSchema
});

export const branchRequestSchema = z.object({
  runId: z.string().min(1),
  branch: z.string().min(1),
  sha: z.string().min(1)
});

export const testsRequestSchema = z.object({
  runId: z.string().min(1),
  sha: z.string().min(1),
  suite: z.string().min(1),
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  output: z.string().optional()
});

export const subscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  runId: z.string().min(1)
});

export const okResponseSchema = z.object({ ok: z.literal(true) });
