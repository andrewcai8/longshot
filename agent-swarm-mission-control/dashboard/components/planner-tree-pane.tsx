"use client";

import { tree as d3Tree, hierarchy as d3Hierarchy } from "d3-hierarchy";
import { getAgentColor, type AgentRole, type AgentStateDerived, type PlannerTreeDerived, type TaskStateDerived } from "@mission-control/shared";

interface TreeNodeDatum {
  agentId: string;
  children: TreeNodeDatum[];
}

interface PlannerTreePaneProps {
  plannerTree: PlannerTreeDerived;
  agents: Record<string, AgentStateDerived>;
  tasks: Record<string, TaskStateDerived>;
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  collapsedAgentIds: Set<string>;
  onToggleCollapse: (agentId: string) => void;
  roleFilter: AgentRole | "all";
}

function buildVisibleTree(
  rootId: string,
  plannerTree: PlannerTreeDerived,
  collapsed: Set<string>
): TreeNodeDatum {
  const node = plannerTree.nodes[rootId];
  if (!node) {
    return { agentId: rootId, children: [] };
  }

  const children = collapsed.has(rootId)
    ? []
    : node.childAgentIds.map((childId) => buildVisibleTree(childId, plannerTree, collapsed));

  return { agentId: rootId, children };
}

export function PlannerTreePane({
  plannerTree,
  agents,
  tasks,
  selectedAgentId,
  onSelectAgent,
  collapsedAgentIds,
  onToggleCollapse,
  roleFilter
}: PlannerTreePaneProps) {
  const selectedAgent = selectedAgentId ? agents[selectedAgentId] : undefined;
  const selectedAgentTasks = Object.values(tasks)
    .filter((task) => task.assignedAgentId === selectedAgentId)
    .sort((a, b) => b.lastUpdated - a.lastUpdated);

  return (
    <section className="pane">
      <div className="pane-header">
        <h2>Planner Tree</h2>
        <p>Click node to focus. Double-click to collapse subtree.</p>
      </div>

      <div className="tree-wrap">
        {plannerTree.rootAgentIds.map((rootId) => {
          const hierarchyRoot = d3Hierarchy(buildVisibleTree(rootId, plannerTree, collapsedAgentIds));
          const layout = d3Tree<TreeNodeDatum>().nodeSize([90, 140]);
          const laidOut = layout(hierarchyRoot);
          const descendants = laidOut.descendants();
          const links = laidOut.links();

          const minX = Math.min(...descendants.map((node) => node.x), 0) - 80;
          const maxX = Math.max(...descendants.map((node) => node.x), 0) + 80;
          const maxY = Math.max(...descendants.map((node) => node.y), 0) + 120;

          return (
            <svg key={rootId} width="100%" height={Math.max(260, maxY)} viewBox={`${minX} -40 ${maxX - minX} ${Math.max(260, maxY)}`}>
              {links.map((link) => (
                <line
                  key={`${link.source.data.agentId}-${link.target.data.agentId}`}
                  x1={link.source.x}
                  y1={link.source.y}
                  x2={link.target.x}
                  y2={link.target.y}
                  stroke="#9ca8bf"
                  strokeWidth={1.5}
                />
              ))}

              {descendants.map((node) => {
                const agent = agents[node.data.agentId];
                if (!agent) {
                  return null;
                }
                const collapsed = collapsedAgentIds.has(agent.agentId);
                const isSelected = selectedAgentId === agent.agentId;
                const visibleByRole = roleFilter === "all" || roleFilter === agent.role;

                return (
                  <g
                    key={agent.agentId}
                    transform={`translate(${node.x}, ${node.y})`}
                    onClick={() => onSelectAgent(agent.agentId)}
                    onDoubleClick={() => onToggleCollapse(agent.agentId)}
                    style={{ cursor: "pointer", opacity: visibleByRole ? 1 : 0.35 }}
                  >
                    <circle
                      r={isSelected ? 23 : 18}
                      fill={getAgentColor(agent.state)}
                      stroke={isSelected ? "#0b7285" : "#1d2536"}
                      strokeWidth={isSelected ? 3 : 1.2}
                    />
                    <text y={5} textAnchor="middle" fill="#f7fafc" fontSize={10} className="mono">
                      {agent.role.replace("_", " ").slice(0, 6)}
                    </text>
                    <text y={38} textAnchor="middle" fill="#2d3748" fontSize={11}>
                      {agent.name ?? agent.agentId}
                    </text>
                    {plannerTree.nodes[agent.agentId]?.childAgentIds.length ? (
                      <text y={52} textAnchor="middle" fill="#5a6375" fontSize={10}>
                        {collapsed ? "[+]" : "[-]"}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          );
        })}
      </div>

      <div className="details-card">
        <h3>Node Details</h3>
        {!selectedAgent ? (
          <p className="muted">Select an agent node to inspect task, tool, and commit context.</p>
        ) : (
          <>
            <p>
              <span className="muted">Agent:</span> {selectedAgent.name ?? selectedAgent.agentId}
            </p>
            <p>
              <span className="muted">Role:</span> {selectedAgent.role}
            </p>
            <p>
              <span className="muted">State:</span> {selectedAgent.state}
            </p>
            <p>
              <span className="muted">Last Task:</span> {selectedAgentTasks[0]?.title ?? "-"}
            </p>
            <p>
              <span className="muted">Active Tasks:</span> {selectedAgent.activeTaskIds.length}
            </p>
            <p>
              <span className="muted">Last Tool Calls:</span>{" "}
              {selectedAgent.lastToolCalls
                .map((call) => `${call.tool}${call.ok === false ? "(fail)" : ""}`)
                .join(", ") || "-"}
            </p>
            <p>
              <span className="muted">Related Commits:</span>{" "}
              {selectedAgent.relatedCommitShas.slice(0, 4).join(", ") || "-"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
