/**
 * Poke Notifier — sends proactive alerts to your phone via Poke webhooks.
 *
 * Wires into Monitor and Reconciler callbacks to push notifications
 * for worker timeouts, build failures, and milestone completions.
 *
 * Requires: POKE_NOTIFICATIONS=true env var to enable.
 * The Poke SDK reads auth from `npx poke login` session automatically.
 */

import type { MetricsSnapshot, Task } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";

const logger = createLogger("poke-notifier", "root-planner");

interface PokeSDK {
  sendMessage(text: string): Promise<unknown>;
}

export interface PokeNotifierConfig {
  /** Enable/disable notifications. Default: false */
  enabled: boolean;
  /** Min seconds between messages to avoid spam. Default: 60 */
  throttleSeconds: number;
  /** Failed task threshold to trigger alert. Default: 3 */
  failedTaskThreshold: number;
}

export const DEFAULT_POKE_NOTIFIER_CONFIG: PokeNotifierConfig = {
  enabled: false,
  throttleSeconds: 60,
  failedTaskThreshold: 3,
};

export class PokeNotifier {
  private config: PokeNotifierConfig;
  private poke: PokeSDK | null = null;
  private lastMessageTime = 0;
  private initialized = false;

  constructor(config: Partial<PokeNotifierConfig> = {}) {
    this.config = { ...DEFAULT_POKE_NOTIFIER_CONFIG, ...config };
  }

  /**
   * Lazy-initialize the Poke SDK. Only imports if notifications are enabled.
   */
  private async ensureInitialized(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (this.initialized) return this.poke !== null;

    this.initialized = true;
    try {
      const { Poke } = await import("poke");
      this.poke = new Poke();
      logger.info("Poke SDK initialized for notifications");
      return true;
    } catch (err) {
      logger.warn("Failed to initialize Poke SDK — notifications disabled", {
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * Send a message via Poke, respecting throttle limits.
   */
  async send(message: string): Promise<void> {
    if (!(await this.ensureInitialized())) return;

    const now = Date.now() / 1000;
    if (now - this.lastMessageTime < this.config.throttleSeconds) {
      logger.debug("Poke message throttled", { message: message.slice(0, 80) });
      return;
    }

    try {
      await this.poke!.sendMessage(message);
      this.lastMessageTime = now;
      logger.info("Poke notification sent", { message: message.slice(0, 80) });
    } catch (err) {
      logger.error("Failed to send Poke notification", {
        error: (err as Error).message,
      });
    }
  }

  // --- Callback handlers to wire into orchestrator events ---

  async onWorkerTimeout(workerId: string, taskId: string): Promise<void> {
    await this.send(
      `Worker timeout: worker ${workerId} timed out on task ${taskId}. The task will be retried.`,
    );
  }

  async onSweepComplete(fixTasks: Task[]): Promise<void> {
    if (fixTasks.length === 0) return;
    const taskList = fixTasks.map((t) => `- ${t.description.slice(0, 100)}`).join("\n");
    await this.send(
      `Build broken — reconciler created ${fixTasks.length} fix tasks:\n${taskList}`,
    );
  }

  async onMetricsUpdate(snapshot: MetricsSnapshot): Promise<void> {
    if (snapshot.failedTasks >= this.config.failedTaskThreshold) {
      await this.send(
        `Alert: ${snapshot.failedTasks} tasks have failed. ` +
        `${snapshot.activeWorkers} workers active, ${snapshot.pendingTasks} pending. ` +
        `Commits/hr: ${snapshot.commitsPerHour.toFixed(1)}`,
      );
    }
  }

  async onEmptyDiff(workerId: string, taskId: string): Promise<void> {
    await this.send(
      `Empty diff: worker ${workerId} produced no changes for task ${taskId}.`,
    );
  }

  async onError(error: Error): Promise<void> {
    await this.send(`Orchestrator error: ${error.message}`);
  }
}

/**
 * Create a PokeNotifier from environment variables.
 *
 * Set POKE_NOTIFICATIONS=true to enable.
 * Optional: POKE_THROTTLE_SECONDS (default 60)
 * Optional: POKE_FAILED_THRESHOLD (default 3)
 */
export function createPokeNotifier(): PokeNotifier {
  return new PokeNotifier({
    enabled: process.env.POKE_NOTIFICATIONS === "true",
    throttleSeconds: Number(process.env.POKE_THROTTLE_SECONDS) || 60,
    failedTaskThreshold: Number(process.env.POKE_FAILED_THRESHOLD) || 3,
  });
}
