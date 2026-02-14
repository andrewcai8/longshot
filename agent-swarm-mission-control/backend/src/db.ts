import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events(run_id, ts, seq);

    CREATE TABLE IF NOT EXISTS commits (
      run_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      parents_json TEXT NOT NULL,
      branch TEXT,
      agent_id TEXT NOT NULL,
      task_id TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      stats_json TEXT,
      PRIMARY KEY(run_id, sha),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS diffs (
      run_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      unified TEXT NOT NULL,
      files_json TEXT NOT NULL,
      PRIMARY KEY(run_id, sha),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      suite TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      output TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
  `);

  return db;
}
