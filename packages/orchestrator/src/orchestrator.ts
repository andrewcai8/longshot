/**
 * Orchestrator Factory — creates and wires all components.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Task, Handoff, MetricsSnapshot } from "@agentswarm/core";
import { createLogger, createTracer, type Tracer } from "@agentswarm/core";
import { loadConfig, type OrchestratorConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";
import { WorkerPool } from "./worker-pool.js";
import { MergeQueue } from "./merge-queue.js";
import { GitMutex, slugifyForBranch } from "./shared.js";
import { Monitor } from "./monitor.js";
import { Planner } from "./planner.js";
import { Reconciler } from "./reconciler.js";
import { Subplanner, DEFAULT_SUBPLANNER_CONFIG } from "./subplanner.js";

const logger = createLogger("orchestrator", "root-planner");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorCallbacks {
  onTaskCreated?: (task: Task) => void;
  onTaskCompleted?: (task: Task, handoff: Handoff) => void;
  onIterationComplete?: (iteration: number, tasks: Task[], handoffs: Handoff[]) => void;
  onError?: (error: Error) => void;
  onSweepComplete?: (tasks: Task[]) => void;
  onReconcilerError?: (error: Error) => void;
  onWorkerTimeout?: (workerId: string, taskId: string) => void;
  onEmptyDiff?: (workerId: string, taskId: string) => void;
  onMetricsUpdate?: (snapshot: MetricsSnapshot) => void;
  onTaskStatusChange?: (task: Task, oldStatus: string, newStatus: string) => void;
}

export interface Orchestrator {
  /** Underlying components — exposed for advanced use cases. */
  planner: Planner;
  subplanner: Subplanner;
  reconciler: Reconciler;
  monitor: Monitor;
  workerPool: WorkerPool;
  taskQueue: TaskQueue;
  mergeQueue: MergeQueue;
  config: OrchestratorConfig;
  tracer: Tracer;

  /** Start background services (worker pool, monitor, reconciler). */
  start(): Promise<void>;

  /** Gracefully stop all services. */
  stop(): Promise<void>;

  /**
   * Full lifecycle: start → planner.runLoop(request) → stop.
   * Returns the final metrics snapshot.
   */
  run(request: string): Promise<MetricsSnapshot>;

  /** Whether the planner loop is currently running. */
  isRunning(): boolean;

  /** Current metrics snapshot. */
  getSnapshot(): MetricsSnapshot;
}

export interface CreateOrchestratorOptions {
  /**
   * Project root directory. Prompts are read from `<projectRoot>/prompts/`.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;

  /**
   * Override individual config values loaded from env.
   * Applied on top of loadConfig().
   */
  configOverrides?: Partial<Pick<OrchestratorConfig, "maxWorkers" | "targetRepoPath">>;

  /** Max planner iterations before stopping. Default: 100. */
  maxIterations?: number;

  /** Reconciler sweep interval in ms. Default: 300_000 (5 min). */
  reconcilerIntervalMs?: number;

  /** Max fix tasks per reconciler sweep. Default: 5. */
  reconcilerMaxFixTasks?: number;

  /** Callbacks wired to planner/monitor/reconciler events. */
  callbacks?: OrchestratorCallbacks;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createOrchestrator(
  options: CreateOrchestratorOptions = {},
): Promise<Orchestrator> {
  const projectRoot = options.projectRoot ?? process.cwd();

  // --- Config ---
  const config = loadConfig();
  if (options.configOverrides?.maxWorkers !== undefined) {
    config.maxWorkers = options.configOverrides.maxWorkers;
  }
  if (options.configOverrides?.targetRepoPath !== undefined) {
    config.targetRepoPath = options.configOverrides.targetRepoPath;
  }

  logger.info("Config loaded", {
    maxWorkers: config.maxWorkers,
    targetRepo: config.targetRepoPath,
  });
  logger.debug("Full config", {
    maxWorkers: config.maxWorkers,
    workerTimeout: config.workerTimeout,
    mergeStrategy: config.mergeStrategy,
    model: config.llm.model,
    maxTokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    endpoints: config.llm.endpoints.map(e => ({ name: e.name, endpoint: e.endpoint, weight: e.weight })),
    repoUrl: config.git.repoUrl,
    mainBranch: config.git.mainBranch,
    branchPrefix: config.git.branchPrefix,
    targetRepoPath: config.targetRepoPath,
  });

  // --- Prompts ---
  const readPrompt = async (name: string): Promise<string> => {
    const promptPath = resolve(projectRoot, "prompts", `${name}.md`);
    return readFile(promptPath, "utf-8");
  };

  const [rootPrompt, workerPrompt, reconcilerPrompt, subplannerPrompt] = await Promise.all([
    readPrompt("root-planner"),
    readPrompt("worker"),
    readPrompt("reconciler"),
    readPrompt("subplanner"),
  ]);
  logger.debug("Prompts loaded", {
    rootPromptSize: rootPrompt.length,
    workerPromptSize: workerPrompt.length,
    reconcilerPromptSize: reconcilerPrompt.length,
    subplannerPromptSize: subplannerPrompt.length,
  });

  // --- Components ---
  const taskQueue = new TaskQueue();
  const gitMutex = new GitMutex();

  const workerPool = new WorkerPool(
    {
      maxWorkers: config.maxWorkers,
      workerTimeout: config.workerTimeout,
      llm: config.llm,
      git: config.git,
      pythonPath: config.pythonPath,
      gitToken: process.env.GIT_TOKEN,
    },
    workerPrompt,
  );

  const mergeQueue = new MergeQueue({
    mergeStrategy: config.mergeStrategy,
    mainBranch: config.git.mainBranch,
    repoPath: config.targetRepoPath,
    gitMutex,
  });

  const monitor = new Monitor(
    {
      healthCheckInterval: config.healthCheckInterval,
      workerTimeout: config.workerTimeout,
    },
    workerPool,
    taskQueue,
  );

  const subplanner = new Subplanner(
    config,
    DEFAULT_SUBPLANNER_CONFIG,
    taskQueue,
    workerPool,
    mergeQueue,
    monitor,
    subplannerPrompt,
  );

  const planner = new Planner(
    config,
    { maxIterations: options.maxIterations ?? 100 },
    taskQueue,
    workerPool,
    mergeQueue,
    monitor,
    rootPrompt,
    subplanner,
  );

  const reconciler = new Reconciler(
    config,
    {
      intervalMs: options.reconcilerIntervalMs ?? 300_000,
      maxFixTasks: options.reconcilerMaxFixTasks ?? 5,
    },
    taskQueue,
    monitor,
    reconcilerPrompt,
  );

  // --- Tracer ---
  const tracer = createTracer();
  planner.setTracer(tracer);
  workerPool.setTracer(tracer);
  mergeQueue.setTracer(tracer);
  reconciler.setTracer(tracer);
  subplanner.setTracer(tracer);

  // --- Wire callbacks ---
  const cb = options.callbacks;
  if (cb?.onTaskCreated) planner.onTaskCreated(cb.onTaskCreated);
  if (cb?.onTaskCompleted) planner.onTaskCompleted(cb.onTaskCompleted);
  if (cb?.onIterationComplete) planner.onIterationComplete(cb.onIterationComplete);
  if (cb?.onError) planner.onError(cb.onError);
  if (cb?.onSweepComplete) reconciler.onSweepComplete(cb.onSweepComplete);
  if (cb?.onReconcilerError) reconciler.onError(cb.onReconcilerError);
  if (cb?.onWorkerTimeout) monitor.onWorkerTimeout(cb.onWorkerTimeout);
  if (cb?.onEmptyDiff) monitor.onEmptyDiff(cb.onEmptyDiff);
  if (cb?.onMetricsUpdate) monitor.onMetricsUpdate(cb.onMetricsUpdate);
  if (cb?.onTaskStatusChange) taskQueue.onStatusChange(cb.onTaskStatusChange);

  // --- Instance ---
  let started = false;

  const instance: Orchestrator = {
    planner,
    subplanner,
    reconciler,
    monitor,
    workerPool,
    taskQueue,
    mergeQueue,
    config,
    tracer,

    async start() {
      if (started) return;
      started = true;
      await workerPool.start();
      monitor.start();
      reconciler.start();

      reconciler.onSweepComplete((tasks) => {
        for (const task of tasks) {
          planner.injectTask(task);
        }
      });

      logger.debug("All components started", {
        monitorInterval: config.healthCheckInterval,
        workerTimeout: config.workerTimeout,
        mergeStrategy: config.mergeStrategy,
        maxWorkers: config.maxWorkers,
      });

      mergeQueue.startBackground();
      mergeQueue.onMergeResult((result) => {
        monitor.recordMergeAttempt(result.success);
        logger.info("Merge result", {
          branch: result.branch,
          status: result.status,
          success: result.success,
        });
        logger.debug("Merge result details", {
          branch: result.branch,
          status: result.status,
          success: result.success,
          message: result.message,
          conflicts: result.conflicts,
        });
      });

      let conflictCounter = 0;
      const MAX_CONFLICT_FIX_TASKS = 10;

      mergeQueue.onConflict((info) => {
        if (info.branch.includes("conflict-fix")) {
          logger.warn("Skipping conflict-fix for conflict-fix branch (cascade prevention)", {
            branch: info.branch,
          });
          return;
        }

        if (conflictCounter >= MAX_CONFLICT_FIX_TASKS) {
          logger.warn("Conflict-fix budget exhausted, skipping", {
            branch: info.branch,
            limit: MAX_CONFLICT_FIX_TASKS,
          });
          return;
        }

        conflictCounter++;
        const fixId = `conflict-fix-${String(conflictCounter).padStart(3, "0")}`;
        const fixTask: Task = {
          id: fixId,
          description: `Resolve merge conflict from branch "${info.branch}". Conflicting files: ${info.conflictingFiles.join(", ")}. ` +
            `Open each file, find <<<<<<< / ======= / >>>>>>> blocks, resolve by keeping the correct version based on surrounding code context. ` +
            `Remove all conflict markers. Ensure the file compiles after resolution.`,
          scope: info.conflictingFiles.slice(0, 5),
          acceptance: `No <<<<<<< markers remain in the affected files. tsc --noEmit returns 0 for these files.`,
          branch: `${config.git.branchPrefix}${fixId}-${slugifyForBranch(`resolve merge conflict ${info.branch}`)}`,
          status: "pending",
          createdAt: Date.now(),
          priority: 1,
        };

        logger.info("Creating conflict-resolution task", {
          fixId,
          branch: info.branch,
          conflictingFiles: info.conflictingFiles,
          remainingBudget: MAX_CONFLICT_FIX_TASKS - conflictCounter,
        });

        planner.injectTask(fixTask);
      });

      logger.info("Orchestrator started");
    },

    async stop() {
      planner.stop();
      reconciler.stop();
      mergeQueue.stopBackground();
      monitor.stop();
      await workerPool.stop();
      started = false;

      const snapshot = monitor.getSnapshot();
      logger.info("Orchestrator stopped", { ...snapshot });
    },

    async run(request: string) {
      await instance.start();

      logger.info("Beginning planner loop", { request: request.slice(0, 200) });
      await planner.runLoop(request);

      const snapshot = monitor.getSnapshot();
      logger.info("Planner loop complete", { ...snapshot });

      await instance.stop();

      return snapshot;
    },

    isRunning() {
      return planner.isRunning();
    },

    getSnapshot() {
      return monitor.getSnapshot();
    },
  };

  return instance;
}
