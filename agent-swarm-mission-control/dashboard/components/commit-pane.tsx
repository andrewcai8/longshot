"use client";

import { useEffect, useMemo, useState } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import type { BranchDerived, CommitDerived, DiffFile, DiffResponse } from "@mission-control/shared";
import { getDiff } from "@/lib/api";

interface CommitPaneProps {
  runId?: string;
  commits: CommitDerived[];
  branches: BranchDerived[];
  selectedCommitSha?: string;
  onSelectCommit: (sha: string) => void;
  onJumpToTime: (ts: number) => void;
}

function patchToTexts(patch: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      continue;
    }
    oldLines.push(line);
    newLines.push(line);
  }

  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

export function CommitPane({ runId, commits, branches, selectedCommitSha, onSelectCommit, onJumpToTime }: CommitPaneProps) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const commitBySha = useMemo(() => Object.fromEntries(commits.map((commit) => [commit.sha, commit])), [commits]);

  const graph = useMemo(() => {
    const ordered = [...commits].sort((a, b) => a.createdAt - b.createdAt);
    const laneBySha: Record<string, number> = {};
    const laneByBranch = new Map<string, number>();
    let laneCounter = 0;

    for (const commit of ordered) {
      let lane: number | undefined;

      if (commit.branch && laneByBranch.has(commit.branch)) {
        lane = laneByBranch.get(commit.branch);
      }

      if (lane === undefined && commit.parents.length > 0 && laneBySha[commit.parents[0]] !== undefined) {
        lane = laneBySha[commit.parents[0]];
      }

      if (lane === undefined) {
        lane = laneCounter;
        laneCounter += 1;
      }

      if (commit.branch && !laneByBranch.has(commit.branch)) {
        laneByBranch.set(commit.branch, lane);
      }

      laneBySha[commit.sha] = lane;
    }

    const positions = ordered.map((commit, index) => ({
      commit,
      x: 70 + laneBySha[commit.sha] * 120,
      y: 36 + index * 58,
      lane: laneBySha[commit.sha]
    }));

    return {
      ordered,
      positions,
      laneCount: Math.max(1, laneCounter)
    };
  }, [commits]);

  const selectedCommit = selectedCommitSha ? commitBySha[selectedCommitSha] : undefined;

  useEffect(() => {
    if (!runId || !selectedCommitSha) {
      setDiff(null);
      setDiffError(null);
      return;
    }

    void (async () => {
      try {
        setDiffError(null);
        const nextDiff = await getDiff(runId, selectedCommitSha);
        setDiff(nextDiff);
        setSelectedPath(nextDiff.files[0]?.path ?? null);
      } catch (error) {
        setDiff(null);
        setDiffError(error instanceof Error ? error.message : "Unable to fetch diff");
      }
    })();
  }, [runId, selectedCommitSha]);

  const selectedFile: DiffFile | undefined = diff?.files.find((file) => file.path === selectedPath) ?? diff?.files[0];
  const parsed = selectedFile ? patchToTexts(selectedFile.patch) : null;

  return (
    <section className="pane">
      <div className="pane-header">
        <h2>Artifacts: Commit DAG</h2>
        <p>{branches.map((branch) => `${branch.branch}:${branch.sha.slice(0, 6)}`).join(" · ")}</p>
      </div>

      <div className="dag-wrap">
        <svg width={Math.max(540, graph.laneCount * 130)} height={Math.max(180, graph.positions.length * 60 + 40)}>
          {graph.positions.map((node) =>
            node.commit.parents.map((parentSha) => {
              const parentNode = graph.positions.find((candidate) => candidate.commit.sha === parentSha);
              if (!parentNode) {
                return null;
              }
              return (
                <line
                  key={`${node.commit.sha}-${parentSha}`}
                  x1={node.x}
                  y1={node.y}
                  x2={parentNode.x}
                  y2={parentNode.y}
                  stroke="#8d99ae"
                  strokeWidth={1.4}
                />
              );
            })
          )}

          {graph.positions.map((node) => {
            const selected = node.commit.sha === selectedCommitSha;
            return (
              <g key={node.commit.sha} transform={`translate(${node.x}, ${node.y})`} onClick={() => onSelectCommit(node.commit.sha)} style={{ cursor: "pointer" }}>
                <circle r={selected ? 11 : 8} fill={selected ? "#0b7285" : "#1d3557"} />
                <text x={16} y={4} fontSize={12} fill="#1d2536" className="mono">
                  {node.commit.sha.slice(0, 10)}
                </text>
                <text x={16} y={19} fontSize={11} fill="#5a6375">
                  {node.commit.message.slice(0, 54)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="details-card">
        <h3>Commit Details</h3>
        {!selectedCommit ? (
          <p className="muted">Select a commit node to inspect metadata and diff.</p>
        ) : (
          <>
            <p>
              <span className="muted">sha:</span> <span className="mono">{selectedCommit.sha}</span>
            </p>
            <p>
              <span className="muted">message:</span> {selectedCommit.message}
            </p>
            <p>
              <span className="muted">agent:</span> {selectedCommit.agentId}
            </p>
            <p>
              <span className="muted">task:</span> {selectedCommit.taskId ?? "-"}
            </p>
            <p>
              <span className="muted">stats:</span>{" "}
              {selectedCommit.stats
                ? `${selectedCommit.stats.filesChanged} files, +${selectedCommit.stats.insertions}/-${selectedCommit.stats.deletions}`
                : "-"}
            </p>
            <p>
              <span className="muted">tests:</span>{" "}
              {selectedCommit.tests.map((test) => `${test.suite}:${test.ok ? "ok" : "fail"}`).join(", ") || "-"}
            </p>
            <button className="small" onClick={() => onJumpToTime(selectedCommit.createdAt)}>
              Jump To Commit Time
            </button>
          </>
        )}
      </div>

      {diffError ? <p className="error">{diffError}</p> : null}

      {diff ? (
        <div className="diff-panel">
          <div className="file-list">
            {diff.files.map((file) => (
              <button
                key={file.path}
                className={`file-chip ${selectedFile?.path === file.path ? "selected" : ""}`}
                onClick={() => setSelectedPath(file.path)}
              >
                {file.status.toUpperCase()} {file.path}
              </button>
            ))}
          </div>

          {selectedFile && parsed ? (
            <>
              <ReactDiffViewer
                oldValue={parsed.oldText}
                newValue={parsed.newText}
                splitView={false}
                useDarkTheme={false}
              />
              <details>
                <summary>Unified Patch</summary>
                <pre className="unified">{selectedFile.patch}</pre>
              </details>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
