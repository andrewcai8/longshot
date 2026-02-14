import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const dotenvCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env")
];

for (const envPath of dotenvCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveDbPath(raw: string | undefined): string {
  const value = raw ?? "./data/mission_control.sqlite";
  if (path.isAbsolute(value)) {
    return value;
  }

  const cwd = process.cwd();
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  const inBackendDir = path.basename(cwd) === "backend";

  if (inBackendDir && normalized.startsWith("backend/")) {
    return path.resolve(cwd, "..", normalized);
  }

  return path.resolve(cwd, normalized);
}

export const config = {
  backendPort: parsePort(process.env.BACKEND_PORT, 4000),
  dashboardOrigin: process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000",
  dbPath: resolveDbPath(process.env.DB_PATH)
};
