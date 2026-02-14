export type AgentRole = "root_planner" | "planner" | "subplanner" | "worker";
export type AgentRuntimeState = "idle" | "thinking" | "running_tools" | "blocked" | "failed" | "done";
export type TaskStatus = "backlog" | "in_progress" | "blocked" | "done" | "failed" | "retry";
export type DiffFileStatus = "added" | "modified" | "deleted";

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  patch: string;
}

export interface DiffPayload {
  files: DiffFile[];
  unified: string;
}

export interface CommitStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface AgentSpawnedPayload {
  agentId: string;
  role: AgentRole;
  parentAgentId?: string;
  name?: string;
}

export interface AgentStateChangedPayload {
  agentId: string;
  state: AgentRuntimeState;
  note?: string;
}

export interface TaskCreatedPayload {
  taskId: string;
  ownerPlannerId: string;
  title: string;
  description?: string;
}

export interface TaskAssignedPayload {
  taskId: string;
  agentId: string;
}

export interface TaskStatusChangedPayload {
  taskId: string;
  status: TaskStatus;
  note?: string;
}

export interface HandoffSubmittedPayload {
  handoffId: string;
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  summary: string;
  notes?: string;
}

export interface ToolCalledPayload {
  toolCallId: string;
  agentId: string;
  taskId?: string;
  tool: string;
  inputSummary?: string;
}

export interface ToolFinishedPayload {
  toolCallId: string;
  agentId: string;
  taskId?: string;
  ok: boolean;
  outputSummary?: string;
  durationMs?: number;
}

export interface GitCommitCreatedPayload {
  sha: string;
  parents: string[];
  branch?: string;
  agentId: string;
  taskId?: string;
  message: string;
  createdAt?: number;
  stats?: CommitStats;
  diff?: DiffPayload;
}

export interface GitBranchUpdatedPayload {
  branch: string;
  sha: string;
}

export interface TestsResultPayload {
  sha: string;
  suite: string;
  ok: boolean;
  durationMs: number;
  output?: string;
}

export interface EventPayloadMap {
  "agent.spawned": AgentSpawnedPayload;
  "agent.state_changed": AgentStateChangedPayload;
  "task.created": TaskCreatedPayload;
  "task.assigned": TaskAssignedPayload;
  "task.status_changed": TaskStatusChangedPayload;
  "handoff.submitted": HandoffSubmittedPayload;
  "tool.called": ToolCalledPayload;
  "tool.finished": ToolFinishedPayload;
  "git.commit_created": GitCommitCreatedPayload;
  "git.branch_updated": GitBranchUpdatedPayload;
  "tests.result": TestsResultPayload;
}

export type EventType = keyof EventPayloadMap;

export type EventEnvelope<T extends EventType = EventType> = {
  eventId: string;
  runId: string;
  ts: number;
  type: T;
  payload: EventPayloadMap[T];
};

export type AnyEventEnvelope = {
  [K in EventType]: EventEnvelope<K>;
}[EventType];

export interface RunSummary {
  runId: string;
  name: string;
  createdAt: number;
}

export interface CreateRunRequest {
  name: string;
}

export interface CreateRunResponse {
  runId: string;
}

export interface ListRunsResponse {
  runs: RunSummary[];
}

export interface AppendEventsRequest {
  runId: string;
  events: AnyEventEnvelope[];
}

export interface AppendEventsResponse {
  ok: true;
  inserted: number;
}

export interface QueryEventsResponse {
  events: AnyEventEnvelope[];
}

export interface AgentStateDerived {
  agentId: string;
  role: AgentRole;
  parentAgentId?: string;
  name?: string;
  state: AgentRuntimeState;
  note?: string;
  lastUpdated: number;
  activeTaskIds: string[];
  relatedCommitShas: string[];
  lastToolCalls: Array<{
    toolCallId: string;
    tool: string;
    ts: number;
    ok?: boolean;
  }>;
}

export interface TaskStateDerived {
  taskId: string;
  ownerPlannerId: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  status: TaskStatus;
  note?: string;
  lastUpdated: number;
  history: Array<{
    ts: number;
    status: TaskStatus;
    note?: string;
  }>;
}

export interface PlannerTreeNodeDerived {
  agentId: string;
  role: AgentRole;
  state: AgentRuntimeState;
  parentAgentId?: string;
  name?: string;
  childAgentIds: string[];
  activeTaskCount: number;
  totalTaskCount: number;
}

export interface PlannerTreeDerived {
  rootAgentIds: string[];
  nodes: Record<string, PlannerTreeNodeDerived>;
}

export interface CommitDerived {
  sha: string;
  parents: string[];
  branch?: string;
  agentId: string;
  taskId?: string;
  message: string;
  createdAt: number;
  stats?: CommitStats;
  tests: TestsResultPayload[];
}

export interface BranchDerived {
  branch: string;
  sha: string;
  updatedAt: number;
}

export interface MetricsDerived {
  commitsPerHour: number;
  eventsPerMinute: number;
  failureRate: number;
  testsPassRate: number;
}

export interface DerivedStateSnapshot {
  at: number;
  agents: Record<string, AgentStateDerived>;
  tasks: Record<string, TaskStateDerived>;
  plannerTree: PlannerTreeDerived;
  commits: CommitDerived[];
  branches: BranchDerived[];
  metrics: MetricsDerived;
}

export interface StateResponse extends DerivedStateSnapshot {}

export interface DiffResponse {
  sha: string;
  files: DiffFile[];
  unified: string;
}

export interface AgentCreateRequest {
  runId: string;
  agent: AgentSpawnedPayload;
}

export interface TaskCreateRequest {
  runId: string;
  task: TaskCreatedPayload;
}

export interface TaskAssignRequest {
  runId: string;
  taskId: string;
  agentId: string;
}

export interface TaskStatusRequest {
  runId: string;
  taskId: string;
  status: TaskStatus;
  note?: string;
}

export interface AgentStateRequest {
  runId: string;
  agentId: string;
  state: AgentRuntimeState;
  note?: string;
}

export interface HandoffRequest {
  runId: string;
  handoff: HandoffSubmittedPayload;
}

export interface CommitRequest {
  runId: string;
  commit: Omit<GitCommitCreatedPayload, "diff">;
  diff: DiffPayload;
}

export interface BranchRequest {
  runId: string;
  branch: string;
  sha: string;
}

export interface TestsRequest {
  runId: string;
  sha: string;
  suite: string;
  ok: boolean;
  durationMs: number;
  output?: string;
}

export interface OkResponse {
  ok: true;
}

export type StreamServerMessage =
  | { type: "hello"; serverTime: number }
  | { type: "event"; event: AnyEventEnvelope };

export type StreamClientMessage = { type: "subscribe"; runId: string };
