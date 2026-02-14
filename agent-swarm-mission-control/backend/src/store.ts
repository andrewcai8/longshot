import { randomUUID } from "node:crypto";
import {
  deriveStateFromEvents,
  type AnyEventEnvelope,
  type DiffResponse,
  type GitCommitCreatedPayload,
  type ListRunsResponse,
  type RunSummary,
  type TestsResultPayload
} from "@mission-control/shared";
import type { DatabaseSync } from "node:sqlite";

interface EventRow {
  event_id: string;
  run_id: string;
  ts: number;
  type: AnyEventEnvelope["type"];
  payload_json: string;
}

interface CommitRow {
  sha: string;
  parents_json: string;
  branch: string | null;
  agent_id: string;
  task_id: string | null;
  message: string;
  created_at: number;
  stats_json: string | null;
}

interface DiffRow {
  sha: string;
  unified: string;
  files_json: string;
}

export class MissionControlStore {
  constructor(private readonly db: DatabaseSync) {}

  createRun(name: string): string {
    const runId = randomUUID();
    const createdAt = Date.now();

    this.db
      .prepare("INSERT INTO runs(run_id, name, created_at) VALUES (?, ?, ?)")
      .run(runId, name, createdAt);

    return runId;
  }

  listRuns(): ListRunsResponse {
    const rows = this.db
      .prepare("SELECT run_id, name, created_at FROM runs ORDER BY created_at DESC")
      .all() as Array<{ run_id: string; name: string; created_at: number }>;

    const runs: RunSummary[] = rows.map((row) => ({
      runId: row.run_id,
      name: row.name,
      createdAt: row.created_at
    }));

    return { runs };
  }

  hasRun(runId: string): boolean {
    const row = this.db.prepare("SELECT 1 as ok FROM runs WHERE run_id = ? LIMIT 1").get(runId) as { ok: number } | undefined;
    return Boolean(row?.ok);
  }

  appendEvents(runId: string, events: AnyEventEnvelope[]): number {
    const insertEvent = this.db.prepare(
      "INSERT INTO events(event_id, run_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)"
    );
    const upsertCommit = this.db.prepare(`
      INSERT INTO commits(run_id, sha, parents_json, branch, agent_id, task_id, message, created_at, stats_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, sha) DO UPDATE SET
        parents_json = excluded.parents_json,
        branch = excluded.branch,
        agent_id = excluded.agent_id,
        task_id = excluded.task_id,
        message = excluded.message,
        created_at = excluded.created_at,
        stats_json = excluded.stats_json
    `);
    const upsertDiff = this.db.prepare(`
      INSERT INTO diffs(run_id, sha, unified, files_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, sha) DO UPDATE SET
        unified = excluded.unified,
        files_json = excluded.files_json
    `);
    const insertTest = this.db.prepare(
      "INSERT INTO tests(run_id, sha, suite, ok, duration_ms, output) VALUES (?, ?, ?, ?, ?, ?)"
    );

    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        insertEvent.run(event.eventId, runId, event.ts, event.type, JSON.stringify(event.payload));

        if (event.type === "git.commit_created") {
          const payload = event.payload as GitCommitCreatedPayload;
          upsertCommit.run(
            runId,
            payload.sha,
            JSON.stringify(payload.parents),
            payload.branch ?? null,
            payload.agentId,
            payload.taskId ?? null,
            payload.message,
            payload.createdAt ?? event.ts,
            payload.stats ? JSON.stringify(payload.stats) : null
          );

          if (payload.diff) {
            upsertDiff.run(runId, payload.sha, payload.diff.unified, JSON.stringify(payload.diff.files));
          }
        }

        if (event.type === "tests.result") {
          const payload = event.payload as TestsResultPayload;
          insertTest.run(runId, payload.sha, payload.suite, payload.ok ? 1 : 0, payload.durationMs, payload.output ?? null);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return events.length;
  }

  getEvents(runId: string, until?: number): AnyEventEnvelope[] {
    const query =
      until === undefined
        ? "SELECT event_id, run_id, ts, type, payload_json FROM events WHERE run_id = ? ORDER BY ts ASC, seq ASC"
        : "SELECT event_id, run_id, ts, type, payload_json FROM events WHERE run_id = ? AND ts <= ? ORDER BY ts ASC, seq ASC";

    const rows = (until === undefined ? this.db.prepare(query).all(runId) : this.db.prepare(query).all(runId, until)) as EventRow[];

    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      ts: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload_json)
    })) as AnyEventEnvelope[];
  }

  getState(runId: string, at?: number) {
    const events = this.getEvents(runId, at);
    return deriveStateFromEvents(events, at);
  }

  getDiff(runId: string, sha: string): DiffResponse | null {
    const row = this.db
      .prepare("SELECT sha, unified, files_json FROM diffs WHERE run_id = ? AND sha = ? LIMIT 1")
      .get(runId, sha) as DiffRow | undefined;

    if (!row) {
      return null;
    }

    return {
      sha: row.sha,
      unified: row.unified,
      files: JSON.parse(row.files_json)
    };
  }

  getCommit(runId: string, sha: string): CommitRow | null {
    const row = this.db
      .prepare("SELECT sha, parents_json, branch, agent_id, task_id, message, created_at, stats_json FROM commits WHERE run_id = ? AND sha = ?")
      .get(runId, sha) as CommitRow | undefined;
    return row ?? null;
  }
}
