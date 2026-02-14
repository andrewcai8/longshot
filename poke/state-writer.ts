/**
 * Poke State Writer — writes orchestrator state to disk as JSON files
 * so the Poke MCP server can read and serve them as tool responses.
 *
 * Writes to STATE_DIR (default: ./state/):
 *   - metrics.json: latest MetricsSnapshot
 *   - tasks.json: all tasks with current status
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MetricsSnapshot, Task } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";

const logger = createLogger("poke-state-writer", "root-planner");

export class PokeStateWriter {
  private stateDir: string;
  private initialized = false;

  constructor(stateDir?: string) {
    this.stateDir = stateDir || process.env.AGENTSWARM_STATE_DIR || "./state";
  }

  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.stateDir, { recursive: true });
    this.initialized = true;
  }

  async writeMetrics(snapshot: MetricsSnapshot): Promise<void> {
    try {
      await this.ensureDir();
      await writeFile(join(this.stateDir, "metrics.json"), JSON.stringify(snapshot, null, 2));
    } catch (err) {
      logger.error("Failed to write metrics state", { error: (err as Error).message });
    }
  }

  async writeTasks(tasks: Task[]): Promise<void> {
    try {
      await this.ensureDir();
      const serializable = tasks.map((t) => ({
        id: t.id,
        description: t.description,
        status: t.status,
        priority: t.priority,
        scope: t.scope,
        branch: t.branch,
        assignedTo: t.assignedTo,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
      }));
      await writeFile(join(this.stateDir, "tasks.json"), JSON.stringify(serializable, null, 2));
    } catch (err) {
      logger.error("Failed to write tasks state", { error: (err as Error).message });
    }
  }
}
