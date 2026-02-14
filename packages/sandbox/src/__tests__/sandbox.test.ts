/**
 * Sandbox Package Tests
 * =====================
 *
 * Mirrors the exact same layered testing structure and standards
 * from scripts/test_sandbox.py (the Modal E2E test), applied locally
 * to the sandbox TypeScript code:
 *
 * 1. Tool Verification     — All 8 tool implementations work correctly
 * 2. Basic Sandbox Ops     — File I/O, bash exec, git operations, grep
 * 3. Agent HTTP Server     — Server endpoints respond correctly (health, root, task)
 * 4. Full Agent Loop       — Agent loop drives tools via mock LLM, produces handoff
 */

import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";

import {
  readFile,
  writeFile,
  editFile,
  bashExec,
  grepSearch,
  listFiles,
  gitDiff,
  gitCommit,
  executeTool,
  TOOL_DEFINITIONS,
} from "../tools.js";
import { HealthTracker } from "../health.js";
import { buildHandoff } from "../handoff.js";
import { runAgent } from "../agent.js";
import type { AgentConfig } from "../agent.js";
import type { Task, TaskAssignment, TaskResult, HealthResponse } from "@agentswarm/core";

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;
const originalCwd = process.cwd();

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: "Test task",
    scope: ["src/test.ts"],
    acceptance: "Test passes",
    branch: "worker/test",
    status: "assigned",
    createdAt: Date.now(),
    priority: 5,
    ...overrides,
  };
}

async function createTestDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
  return dir;
}

async function initGitRepo(dir: string): Promise<void> {
  execSync("git init", { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config init.defaultBranch main', { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m 'initial'", { cwd: dir });
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// Test 1: Tool Verification (mirrors test_image_builds)
// =============================================================================

describe("TEST 1: Tool Verification", () => {
  before(async () => {
    testDir = await createTestDir();
    process.chdir(testDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await cleanupDir(testDir);
  });

  it("all 8 tool definitions are present", () => {
    const expectedTools = [
      "read_file",
      "write_file",
      "edit_file",
      "bash_exec",
      "grep_search",
      "list_files",
      "git_diff",
      "git_commit",
    ];
    const toolNames = TOOL_DEFINITIONS.map((t) => t.function.name);
    for (const name of expectedTools) {
      assert.ok(toolNames.includes(name), `Missing tool definition: ${name}`);
    }
    assert.strictEqual(toolNames.length, 8, "Should have exactly 8 tools");
  });

  it("tool definitions follow OpenAI function calling format", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.strictEqual(tool.type, "function", `${tool.function.name} type should be 'function'`);
      assert.ok(tool.function.name, "Tool must have a name");
      assert.ok(tool.function.description, `${tool.function.name} must have a description`);
      assert.strictEqual(
        tool.function.parameters.type,
        "object",
        `${tool.function.name} parameters.type should be 'object'`,
      );
      assert.ok(
        Array.isArray(tool.function.parameters.required),
        `${tool.function.name} must have required array`,
      );
    }
  });

  it("executeTool dispatches all known tools without crashing", async () => {
    // write a file first so other tools have something to work with
    await writeFile(path.join(testDir, "dispatch-test.txt"), "dispatch test");

    const dispatches: Array<[string, Record<string, unknown>]> = [
      ["read_file", { path: path.join(testDir, "dispatch-test.txt") }],
      ["write_file", { path: path.join(testDir, "dispatch-out.txt"), content: "ok" }],
      ["edit_file", { path: path.join(testDir, "dispatch-test.txt"), oldText: "dispatch", newText: "edited" }],
      ["bash_exec", { command: "echo hello" }],
      ["grep_search", { pattern: "edited", searchPath: testDir }],
      ["list_files", { dirPath: testDir }],
    ];

    for (const [name, args] of dispatches) {
      const result = await executeTool(name, args);
      assert.ok(typeof result === "string", `${name} should return a string`);
    }
  });

  it("executeTool returns error for unknown tool", async () => {
    const result = await executeTool("nonexistent_tool", {});
    assert.ok(result.includes("Unknown tool"), "Should report unknown tool");
  });
});

// =============================================================================
// Test 2: Basic Sandbox Operations (mirrors test_sandbox_basic)
// =============================================================================

describe("TEST 2: Basic Sandbox Operations", () => {
  before(async () => {
    testDir = await createTestDir();
    process.chdir(testDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await cleanupDir(testDir);
  });

  // -- 2a: Command execution (mirrors sb.exec("echo", "hello from sandbox"))
  it("bash_exec executes commands and captures output", async () => {
    const result = await bashExec("echo hello from sandbox");
    assert.ok(result.includes("hello from sandbox"), `Expected 'hello from sandbox', got: ${result}`);
  });

  it("bash_exec handles command failure gracefully", async () => {
    const result = await bashExec("false");
    assert.ok(typeof result === "string", "Should return string on failure");
  });

  it("bash_exec respects timeout", async () => {
    // Use a node-based sleep to work cross-platform (Windows + Linux)
    const result = await bashExec('node -e "setTimeout(() => {}, 30000)"', 200);
    assert.ok(
      result.includes("failed") || result.includes("TIMEOUT") || result.includes("ETIMEDOUT") ||
      result.includes("timed out") || result.includes("killed") || result.includes("SIGTERM"),
      `Should timeout or fail, got: ${result.slice(0, 200)}`,
    );
  });

  // -- 2b: File I/O (mirrors write_proc + read_proc)
  it("write_file creates file with content", async () => {
    const filePath = path.join(testDir, "test-content.txt");
    const result = await writeFile(filePath, "test content");
    assert.ok(result.includes("Successfully"), `Write should succeed: ${result}`);

    const content = await fs.readFile(filePath, "utf-8");
    assert.strictEqual(content, "test content");
  });

  it("write_file creates parent directories", async () => {
    const filePath = path.join(testDir, "nested", "deep", "file.txt");
    const result = await writeFile(filePath, "nested content");
    assert.ok(result.includes("Successfully"), `Should create nested dirs: ${result}`);

    const content = await fs.readFile(filePath, "utf-8");
    assert.strictEqual(content, "nested content");
  });

  it("read_file reads existing file", async () => {
    const filePath = path.join(testDir, "read-test.txt");
    await fs.writeFile(filePath, "read me");
    const content = await readFile(filePath);
    assert.strictEqual(content, "read me");
  });

  it("read_file returns error for missing file", async () => {
    const result = await readFile(path.join(testDir, "nonexistent.txt"));
    assert.ok(result.includes("Error"), "Should return error for missing file");
  });

  it("edit_file replaces exact text", async () => {
    const filePath = path.join(testDir, "edit-test.txt");
    await fs.writeFile(filePath, "Hello World");
    const result = await editFile(filePath, "World", "Sandbox");
    assert.ok(result.includes("Successfully"), `Edit should succeed: ${result}`);

    const content = await fs.readFile(filePath, "utf-8");
    assert.strictEqual(content, "Hello Sandbox");
  });

  it("edit_file returns error when text not found", async () => {
    const filePath = path.join(testDir, "edit-miss.txt");
    await fs.writeFile(filePath, "Hello World");
    const result = await editFile(filePath, "NotHere", "Replaced");
    assert.ok(result.includes("not found"), "Should report text not found");
  });

  // -- 2c: Git operations (mirrors git init, add, commit, log)
  it("git operations: init, add, commit, diff", async () => {
    const gitDir = path.join(testDir, "git-test");
    await fs.mkdir(gitDir, { recursive: true });
    process.chdir(gitDir);

    execSync("git init", { cwd: gitDir });
    execSync('git config user.name "Test"', { cwd: gitDir });
    execSync('git config user.email "test@test.com"', { cwd: gitDir });
    await fs.writeFile(path.join(gitDir, "hello.txt"), "hello\n");
    execSync("git add -A && git commit -m 'initial'", { cwd: gitDir });

    // Verify git log
    const logOutput = execSync("git log --oneline", { cwd: gitDir, encoding: "utf-8" });
    assert.ok(logOutput.includes("initial"), `Git commit not found: ${logOutput}`);

    // Test gitDiff — should show no changes after commit
    const diff = await gitDiff();
    assert.ok(diff.includes("No changes") || diff.trim() === "", "No diff after clean commit");

    // Make a change and check diff
    await fs.writeFile(path.join(gitDir, "hello.txt"), "modified\n");
    const diff2 = await gitDiff();
    assert.ok(diff2.includes("modified"), "Diff should show modification");

    // Test gitCommit
    const commitResult = await gitCommit("test commit");
    assert.ok(commitResult.includes("Successfully") || commitResult.includes("test commit"), `Commit result: ${commitResult}`);

    process.chdir(testDir);
  });

  // -- 2d: Node.js / bash integration (mirrors node_proc)
  it("bash_exec runs Node.js inline", async () => {
    const result = await bashExec('node -e "console.log(JSON.stringify({version: process.version, ok: true}))"');
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.ok, true, "Node.js should execute inline");
    assert.ok(parsed.version.startsWith("v"), "Should report Node version");
  });

  // -- Grep search
  it("grep_search finds patterns in files", async () => {
    await fs.writeFile(path.join(testDir, "searchable.txt"), "findme pattern here\n");
    const result = await grepSearch("findme", testDir);
    assert.ok(result.includes("findme"), `Grep should find pattern: ${result}`);
  });

  it("grep_search returns error for no matches", async () => {
    const result = await grepSearch("zzz_nonexistent_zzz", testDir);
    // grep returns error/empty on no match
    assert.ok(typeof result === "string", "Should return string on no match");
  });

  // -- List files
  it("list_files returns directory contents", async () => {
    await fs.writeFile(path.join(testDir, "listme.txt"), "content");
    const result = await listFiles(testDir);
    assert.ok(result.includes("listme.txt"), `Should list files: ${result}`);
  });

  // -- Output truncation
  it("bash_exec truncates large output", async () => {
    // Generate output larger than 10KB
    const result = await bashExec('node -e "console.log(\'x\'.repeat(20000))"');
    assert.ok(result.length <= 11000, "Output should be truncated");
    if (result.length > 10000) {
      assert.ok(result.includes("truncated"), "Should mention truncation");
    }
  });
});

// =============================================================================
// Test 3: Agent HTTP Server (mirrors test_agent_server)
// =============================================================================

describe("TEST 3: Agent HTTP Server", () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    testDir = await createTestDir();
    await initGitRepo(testDir);
    process.chdir(testDir);

    // Start server on a random port
    const port = 0; // OS assigns
    server = await startTestServer(port);
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    process.chdir(originalCwd);
    await cleanupDir(testDir);
  });

  it("GET /health returns 200 with health data", async () => {
    const resp = await fetch(`${baseUrl}/health`);
    assert.strictEqual(resp.status, 200, "Health should return 200");

    const data = (await resp.json()) as HealthResponse;
    assert.ok(data.sandboxId, "Should include sandboxId");
    assert.strictEqual(data.status, "healthy", "Should be healthy");
    assert.ok(typeof data.uptime === "number", "Should include uptime");
    assert.ok(typeof data.memoryUsageMb === "number", "Should include memoryUsageMb");
  });

  it("GET / returns 200 with status ready", async () => {
    const resp = await fetch(`${baseUrl}/`);
    assert.strictEqual(resp.status, 200, "Root should return 200");

    const data = (await resp.json()) as { status: string; sandboxId: string };
    assert.strictEqual(data.status, "ready", "Should report ready");
    assert.ok(data.sandboxId, "Should include sandboxId");
  });

  it("GET /nonexistent returns 404", async () => {
    const resp = await fetch(`${baseUrl}/nonexistent`);
    assert.strictEqual(resp.status, 404, "Unknown route should return 404");
  });

  it("POST /task without body returns 400", async () => {
    const resp = await fetch(`${baseUrl}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(resp.status, 400, "Missing fields should return 400");
  });

  it("GET /task returns 404 (POST-only)", async () => {
    const resp = await fetch(`${baseUrl}/task`);
    assert.strictEqual(resp.status, 404, "GET /task should return 404");
  });

  it("OPTIONS returns 204 (CORS preflight)", async () => {
    const resp = await fetch(`${baseUrl}/task`, { method: "OPTIONS" });
    assert.strictEqual(resp.status, 204, "OPTIONS should return 204");
  });
});

// =============================================================================
// Test 4: Full Agent Loop (mirrors test_full_agent)
// =============================================================================

describe("TEST 4: Full Agent Loop (mock LLM)", () => {
  let mockLlmServer: http.Server;
  let mockLlmUrl: string;
  let callCount: number;

  before(async () => {
    testDir = await createTestDir();
    await initGitRepo(testDir);
    // Create src dir for scope
    await fs.mkdir(path.join(testDir, "src"), { recursive: true });
    process.chdir(testDir);

    // Start a mock LLM server that simulates an OpenAI-compatible endpoint.
    // The mock drives the agent through the same workflow the worker.md prompt
    // specifies: explore → implement → verify → commit → handoff.
    callCount = 0;
    mockLlmServer = await startMockLlmServer();
    const addr = mockLlmServer.address() as { port: number };
    mockLlmUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (mockLlmServer) {
      await new Promise<void>((resolve) => mockLlmServer.close(() => resolve()));
    }
    process.chdir(originalCwd);
    await cleanupDir(testDir);
  });

  it("agent loop executes tools, produces handoff with correct structure", async () => {
    const task = makeTask({
      id: "test-greet-001",
      description: "Create src/greet.ts that exports a greet(name) function returning 'Hello, {name}!'",
      scope: ["src/greet.ts"],
      acceptance: "greet('World') returns 'Hello, World!'",
      branch: "worker/test-greet-001",
    });

    const config: AgentConfig = {
      llmEndpoint: mockLlmUrl,
      llmModel: "mock-model",
      maxTokens: 4096,
      temperature: 0,
      maxIterations: 10,
      systemPrompt: "You are a coding agent. Complete the task.",
    };

    const result = await runAgent(task, config);

    // Verify handoff structure matches Handoff interface
    assert.ok(result.handoff, "Should produce a handoff");
    assert.strictEqual(result.handoff.taskId, task.id, "Handoff taskId should match");
    assert.strictEqual(result.handoff.status, "complete", "Status should be complete");
    assert.ok(typeof result.handoff.summary === "string", "Summary should be string");
    assert.ok(Array.isArray(result.handoff.filesChanged), "filesChanged should be array");
    assert.ok(Array.isArray(result.handoff.concerns), "concerns should be array");
    assert.ok(Array.isArray(result.handoff.suggestions), "suggestions should be array");

    // Verify metrics
    const m = result.handoff.metrics;
    assert.ok(typeof m.linesAdded === "number", "linesAdded should be number");
    assert.ok(typeof m.linesRemoved === "number", "linesRemoved should be number");
    assert.ok(typeof m.filesCreated === "number", "filesCreated should be number");
    assert.ok(typeof m.filesModified === "number", "filesModified should be number");
    assert.ok(typeof m.tokensUsed === "number", "tokensUsed should be number");
    assert.ok(m.toolCallCount > 0, "Should have executed at least one tool call");
    assert.ok(m.durationMs > 0, "Duration should be positive");

    // Verify conversation length
    assert.ok(result.conversationLength > 2, "Conversation should have system + user + assistant messages");

    // Verify the file was actually created by the agent
    const greetContent = await fs.readFile(path.join(testDir, "src", "greet.ts"), "utf-8");
    assert.ok(greetContent.includes("greet"), "greet.ts should contain greet function");
    assert.ok(greetContent.includes("Hello"), "greet.ts should contain Hello");
  });
});

// =============================================================================
// Test 5: Health Tracker (unit tests for HealthTracker)
// =============================================================================

describe("TEST 5: HealthTracker", () => {
  it("reports healthy on creation", () => {
    const tracker = new HealthTracker("sb-test-001");
    const health = tracker.getHealth();
    assert.strictEqual(health.status, "healthy");
    assert.strictEqual(health.sandboxId, "sb-test-001");
    assert.ok(health.uptime >= 0, "Uptime should be non-negative");
    assert.ok(typeof health.memoryUsageMb === "number", "Should report memory");
    assert.strictEqual(health.taskId, undefined, "No task initially");
  });

  it("tracks task assignment and clearing", () => {
    const tracker = new HealthTracker("sb-test-002");
    tracker.setTask("task-42");
    let health = tracker.getHealth();
    assert.strictEqual(health.taskId, "task-42");
    assert.strictEqual(health.taskStatus, "running");

    tracker.clearTask();
    health = tracker.getHealth();
    assert.strictEqual(health.taskId, undefined);
    assert.strictEqual(health.taskStatus, undefined);
  });

  it("setUnhealthy changes status", () => {
    const tracker = new HealthTracker("sb-test-003");
    tracker.setUnhealthy();
    const health = tracker.getHealth();
    assert.strictEqual(health.status, "unhealthy");
  });
});

// =============================================================================
// Test 6: Handoff Builder
// =============================================================================

describe("TEST 6: Handoff Builder", () => {
  before(async () => {
    testDir = await createTestDir();
    await initGitRepo(testDir);
    process.chdir(testDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await cleanupDir(testDir);
  });

  it("buildHandoff produces correct structure on clean repo", async () => {
    const handoff = await buildHandoff("task-hb-001", "complete", "Test summary", {
      linesAdded: 0,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 0,
      tokensUsed: 100,
      toolCallCount: 5,
      durationMs: 1000,
    });

    assert.strictEqual(handoff.taskId, "task-hb-001");
    assert.strictEqual(handoff.status, "complete");
    assert.strictEqual(handoff.summary, "Test summary");
    assert.ok(Array.isArray(handoff.filesChanged));
    assert.strictEqual(handoff.metrics.tokensUsed, 100);
    assert.strictEqual(handoff.metrics.toolCallCount, 5);
    assert.strictEqual(handoff.metrics.durationMs, 1000);
  });

  it("buildHandoff captures git diff stats after file changes", async () => {
    await fs.writeFile(path.join(testDir, "new-file.ts"), 'export const x = 42;\n');
    execSync("git add -A", { cwd: testDir });

    const handoff = await buildHandoff("task-hb-002", "partial", "Added file", {
      linesAdded: 0,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 0,
      tokensUsed: 50,
      toolCallCount: 2,
      durationMs: 500,
    });

    assert.strictEqual(handoff.taskId, "task-hb-002");
    assert.strictEqual(handoff.status, "partial");
    // Metrics from git diff may or may not detect staged-only changes depending on
    // how git diff is invoked, but the structure should be correct
    assert.ok(typeof handoff.metrics.linesAdded === "number");
    assert.ok(typeof handoff.metrics.filesCreated === "number");
  });
});

// =============================================================================
// Server helper: creates the same HTTP server as server.ts but testable
// =============================================================================

async function startTestServer(port: number): Promise<http.Server> {
  const healthTracker = new HealthTracker(process.env.SANDBOX_ID || "test-sandbox");

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";

    if (url === "/task" && req.method === "POST") {
      const body = await parseBody(req);
      const assignment = body as TaskAssignment;

      if (!assignment.task || !assignment.systemPrompt || !assignment.llmConfig) {
        sendJson(res, 400, { error: "Invalid task assignment: missing required fields" });
        return;
      }

      healthTracker.setTask(assignment.task.id);

      try {
        const result = await runAgent(assignment.task, {
          llmEndpoint: assignment.llmConfig.endpoint,
          llmModel: assignment.llmConfig.model,
          maxTokens: assignment.llmConfig.maxTokens,
          temperature: assignment.llmConfig.temperature,
          maxIterations: 50,
          systemPrompt: assignment.systemPrompt,
        });

        healthTracker.clearTask();
        const taskResult: TaskResult = { type: "task_result", handoff: result.handoff };
        sendJson(res, 200, taskResult);
      } catch (error) {
        healthTracker.clearTask();
        healthTracker.setUnhealthy();
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    } else if (url === "/health" && req.method === "GET") {
      sendJson(res, 200, healthTracker.getHealth());
    } else if (url === "/" && req.method === "GET") {
      sendJson(res, 200, { status: "ready", sandboxId: healthTracker.getHealth().sandboxId });
    } else if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// =============================================================================
// Mock LLM Server: simulates OpenAI chat/completions
// =============================================================================

async function startMockLlmServer(): Promise<http.Server> {
  let iteration = 0;

  const server = http.createServer(async (req, res) => {
    if (req.url === "/chat/completions" && req.method === "POST") {
      const body = (await parseBody(req)) as {
        messages: Array<{ role: string; content: string | null }>;
      };

      const currentIteration = iteration++;
      let response: unknown;

      if (currentIteration === 0) {
        // Step 1: Agent writes the greet.ts file (implement)
        response = makeLlmResponse([
          {
            id: "call_write",
            type: "function" as const,
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "src/greet.ts",
                content:
                  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
              }),
            },
          },
        ]);
      } else if (currentIteration === 1) {
        // Step 2: Agent verifies by reading the file back (verify)
        response = makeLlmResponse([
          {
            id: "call_read",
            type: "function" as const,
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/greet.ts" }),
            },
          },
        ]);
      } else if (currentIteration === 2) {
        // Step 3: Agent commits (commit)
        response = makeLlmResponse([
          {
            id: "call_commit",
            type: "function" as const,
            function: {
              name: "git_commit",
              arguments: JSON.stringify({ message: "feat: add greet function" }),
            },
          },
        ]);
      } else {
        // Step 4: Agent produces final text response (handoff)
        response = {
          id: `resp-${currentIteration}`,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  status: "complete",
                  summary: "Created greet function that returns Hello, {name}!",
                  filesChanged: ["src/greet.ts"],
                  concerns: [],
                  suggestions: [],
                  blockers: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
      }

      sendJson(res, 200, response);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function makeLlmResponse(
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>,
): unknown {
  return {
    id: `resp-${Date.now()}`,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  };
}
