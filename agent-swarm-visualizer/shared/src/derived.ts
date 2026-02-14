import {
  type AgentStateDerived,
  type AgentRuntimeState,
  type AnyEventEnvelope,
  type BranchDerived,
  type CommitDerived,
  type DerivedStateSnapshot,
  type PlannerTreeDerived,
  type TaskStateDerived,
  type TaskStatus,
  type TestsResultPayload
} from "./types";

const ACTIVE_TASK_STATUSES: TaskStatus[] = ["backlog", "in_progress", "blocked", "retry"];

function sortEvents(events: AnyEventEnvelope[]): AnyEventEnvelope[] {
  return [...events].sort((a, b) => {
    if (a.ts !== b.ts) {
      return a.ts - b.ts;
    }
    return a.eventId.localeCompare(b.eventId);
  });
}

export function deriveStateFromEvents(events: AnyEventEnvelope[], at?: number): DerivedStateSnapshot {
  const effectiveAt = at ?? Date.now();
  const scoped = sortEvents(events).filter((event) => event.ts <= effectiveAt);

  const agents: Record<string, AgentStateDerived> = {};
  const tasks: Record<string, TaskStateDerived> = {};
  const commitsBySha: Record<string, CommitDerived> = {};
  const branchesByName: Record<string, BranchDerived> = {};

  const testsBySha: Record<string, TestsResultPayload[]> = {};
  const toolCallsById: Record<string, { agentId: string; tool: string; ts: number; ok?: boolean }> = {};

  for (const event of scoped) {
    switch (event.type) {
      case "agent.spawned": {
        const payload = event.payload;
        agents[payload.agentId] = {
          agentId: payload.agentId,
          role: payload.role,
          parentAgentId: payload.parentAgentId,
          name: payload.name,
          state: "idle",
          lastUpdated: event.ts,
          activeTaskIds: [],
          relatedCommitShas: [],
          lastToolCalls: []
        };
        break;
      }
      case "agent.state_changed": {
        const payload = event.payload;
        const existing = agents[payload.agentId];
        if (!existing) {
          continue;
        }
        existing.state = payload.state;
        existing.note = payload.note;
        existing.lastUpdated = event.ts;
        break;
      }
      case "task.created": {
        const payload = event.payload;
        tasks[payload.taskId] = {
          taskId: payload.taskId,
          ownerPlannerId: payload.ownerPlannerId,
          title: payload.title,
          description: payload.description,
          status: "backlog",
          lastUpdated: event.ts,
          history: [{ ts: event.ts, status: "backlog" }]
        };
        break;
      }
      case "task.assigned": {
        const payload = event.payload;
        const existingTask = tasks[payload.taskId];
        if (!existingTask) {
          continue;
        }
        existingTask.assignedAgentId = payload.agentId;
        existingTask.lastUpdated = event.ts;
        break;
      }
      case "task.status_changed": {
        const payload = event.payload;
        const existingTask = tasks[payload.taskId];
        if (!existingTask) {
          continue;
        }
        existingTask.status = payload.status;
        existingTask.note = payload.note;
        existingTask.lastUpdated = event.ts;
        existingTask.history.push({ ts: event.ts, status: payload.status, note: payload.note });
        break;
      }
      case "tool.called": {
        const payload = event.payload;
        toolCallsById[payload.toolCallId] = {
          agentId: payload.agentId,
          tool: payload.tool,
          ts: event.ts
        };
        const agent = agents[payload.agentId];
        if (!agent) {
          continue;
        }
        agent.lastToolCalls.unshift({
          toolCallId: payload.toolCallId,
          tool: payload.tool,
          ts: event.ts
        });
        agent.lastToolCalls = agent.lastToolCalls.slice(0, 5);
        break;
      }
      case "tool.finished": {
        const payload = event.payload;
        const tool = toolCallsById[payload.toolCallId];
        if (!tool) {
          continue;
        }
        const agent = agents[tool.agentId];
        if (!agent) {
          continue;
        }
        agent.lastToolCalls = agent.lastToolCalls.map((item) =>
          item.toolCallId === payload.toolCallId ? { ...item, ok: payload.ok } : item
        );
        break;
      }
      case "git.commit_created": {
        const payload = event.payload;
        const commit: CommitDerived = {
          sha: payload.sha,
          parents: payload.parents,
          branch: payload.branch,
          agentId: payload.agentId,
          taskId: payload.taskId,
          message: payload.message,
          createdAt: payload.createdAt ?? event.ts,
          stats: payload.stats,
          tests: testsBySha[payload.sha] ?? []
        };
        commitsBySha[payload.sha] = commit;

        const agent = agents[payload.agentId];
        if (agent && !agent.relatedCommitShas.includes(payload.sha)) {
          agent.relatedCommitShas.unshift(payload.sha);
          agent.relatedCommitShas = agent.relatedCommitShas.slice(0, 20);
        }
        if (payload.branch) {
          branchesByName[payload.branch] = {
            branch: payload.branch,
            sha: payload.sha,
            updatedAt: payload.createdAt ?? event.ts
          };
        }
        break;
      }
      case "git.branch_updated": {
        const payload = event.payload;
        branchesByName[payload.branch] = {
          branch: payload.branch,
          sha: payload.sha,
          updatedAt: event.ts
        };
        break;
      }
      case "tests.result": {
        const payload = event.payload;
        if (!testsBySha[payload.sha]) {
          testsBySha[payload.sha] = [];
        }
        testsBySha[payload.sha].push(payload);
        const commit = commitsBySha[payload.sha];
        if (commit) {
          commit.tests = testsBySha[payload.sha];
        }
        break;
      }
      case "handoff.submitted": {
        break;
      }
      default:
        break;
    }
  }

  const taskEntries = Object.values(tasks);
  const activeTaskByAgent: Record<string, string[]> = {};
  for (const task of taskEntries) {
    if (!task.assignedAgentId) {
      continue;
    }
    if (!activeTaskByAgent[task.assignedAgentId]) {
      activeTaskByAgent[task.assignedAgentId] = [];
    }
    if (ACTIVE_TASK_STATUSES.includes(task.status)) {
      activeTaskByAgent[task.assignedAgentId].push(task.taskId);
    }
  }

  for (const agent of Object.values(agents)) {
    agent.activeTaskIds = activeTaskByAgent[agent.agentId] ?? [];
  }

  const treeNodes: PlannerTreeDerived["nodes"] = {};
  const rootAgentIds: string[] = [];

  for (const agent of Object.values(agents)) {
    treeNodes[agent.agentId] = {
      agentId: agent.agentId,
      role: agent.role,
      state: agent.state,
      parentAgentId: agent.parentAgentId,
      name: agent.name,
      childAgentIds: [],
      activeTaskCount: agent.activeTaskIds.length,
      totalTaskCount: taskEntries.filter((task) => task.assignedAgentId === agent.agentId).length
    };
  }

  for (const node of Object.values(treeNodes)) {
    if (node.parentAgentId && treeNodes[node.parentAgentId]) {
      treeNodes[node.parentAgentId].childAgentIds.push(node.agentId);
    } else {
      rootAgentIds.push(node.agentId);
    }
  }

  const commits = Object.values(commitsBySha)
    .map((commit) => ({
      ...commit,
      tests: testsBySha[commit.sha] ?? commit.tests
    }))
    .sort((a, b) => a.createdAt - b.createdAt);

  const branches = Object.values(branchesByName).sort((a, b) => a.branch.localeCompare(b.branch));

  const oneHourAgo = effectiveAt - 60 * 60 * 1000;
  const oneMinuteAgo = effectiveAt - 60 * 1000;
  const commitsInLastHour = commits.filter((commit) => commit.createdAt >= oneHourAgo).length;
  const eventsInLastMinute = scoped.filter((event) => event.ts >= oneMinuteAgo).length;
  const tasksDone = taskEntries.filter((task) => task.status === "done").length;
  const tasksFailed = taskEntries.filter((task) => task.status === "failed").length;

  const tests = Object.values(testsBySha).flat();
  const testsPassed = tests.filter((test) => test.ok).length;

  return {
    at: effectiveAt,
    agents,
    tasks,
    plannerTree: {
      rootAgentIds,
      nodes: treeNodes
    },
    commits,
    branches,
    metrics: {
      commitsPerHour: commitsInLastHour,
      eventsPerMinute: eventsInLastMinute,
      failureRate: tasksDone > 0 ? tasksFailed / tasksDone : 0,
      testsPassRate: tests.length > 0 ? testsPassed / tests.length : 0
    }
  };
}

export function getAgentColor(state: AgentRuntimeState): string {
  switch (state) {
    case "thinking":
      return "#3772ff";
    case "running_tools":
      return "#1f9d55";
    case "blocked":
      return "#b7791f";
    case "failed":
      return "#c53030";
    case "done":
      return "#2f855a";
    case "idle":
    default:
      return "#718096";
  }
}
