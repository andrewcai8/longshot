"""
Lightweight Sandbox + LLM Test
===============================

Tests the full agent pipeline inside a Modal sandbox WITHOUT needing
the compiled sandbox package. Runs the agent logic inline as a Node.js
script inside the base sandbox image.

This proves:
  1. Modal sandbox boots and tools work
  2. Sandbox can reach your LLM endpoint
  3. LLM responds with tool calls
  4. Tools execute inside the sandbox (write_file, read_file, git_commit)
  5. The full loop produces a handoff

Usage:
    python scripts/test_sandbox_lite.py --endpoint https://your-endpoint.modal.run

Cost: ~$0.05 (CPU sandbox only, no GPU)
"""

import argparse
import asyncio
import json
import os
import sys
import time

import modal

# Use the base image — no local file copying, always builds clean
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from infra.sandbox_image import create_agent_image


# The inline agent script that runs inside the sandbox.
# It does the same thing as packages/sandbox/src/agent.ts but as a
# self-contained Node.js script — no build step, no npm install.
AGENT_SCRIPT = r"""
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const LLM_ENDPOINT = process.env.LLM_ENDPOINT;
const LLM_MODEL = process.env.LLM_MODEL || 'Qwen/Qwen2.5-Coder-7B-Instruct';
const WORKSPACE = '/workspace/repo';

// ---- Tool definitions (same as packages/sandbox/src/tools.ts) ----
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Execute a shell command and return output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage all changes and create a git commit',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: 'Directory to list' },
        },
        required: [],
      },
    },
  },
];

// ---- Tool execution ----
function executeTool(name, args) {
  try {
    switch (name) {
      case 'write_file': {
        const dir = path.dirname(args.path);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.path, args.content, 'utf-8');
        return `Wrote ${args.content.length} chars to ${args.path}`;
      }
      case 'read_file': {
        return fs.readFileSync(args.path, 'utf-8');
      }
      case 'bash_exec': {
        return execSync(args.command, {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: WORKSPACE,
          maxBuffer: 5 * 1024 * 1024,
        });
      }
      case 'git_commit': {
        execFileSync('git', ['add', '-A'], { cwd: WORKSPACE });
        return execFileSync('git', ['commit', '-m', args.message], {
          encoding: 'utf-8',
          cwd: WORKSPACE,
        });
      }
      case 'list_files': {
        const dir = args.dirPath || WORKSPACE;
        return execSync(`find ${dir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*'`, {
          encoding: 'utf-8',
          cwd: WORKSPACE,
        });
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ---- LLM call ----
async function callLLM(messages) {
  const url = `${LLM_ENDPOINT}/v1/chat/completions`;
  console.log(`  [LLM] Calling ${url}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: TOOLS,
      max_tokens: 2048,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ---- Main agent loop ----
async function main() {
  console.log('=== Agent starting ===');
  console.log(`LLM endpoint: ${LLM_ENDPOINT}`);
  console.log(`Model: ${LLM_MODEL}`);
  console.log(`Workspace: ${WORKSPACE}`);

  // Init git repo
  execSync('mkdir -p /workspace/repo/src', { encoding: 'utf-8' });
  process.chdir(WORKSPACE);
  execSync('git init && git add -A && git commit -m "initial" --allow-empty', {
    encoding: 'utf-8',
    cwd: WORKSPACE,
  });

  const systemPrompt = `You are a coding agent. You have tools: write_file, read_file, bash_exec, git_commit, list_files. Complete the task, then stop.`;

  const taskPrompt = `Create a file at /workspace/repo/src/greet.ts with this content:
A TypeScript function called greet that takes a name (string) and returns "Hello, {name}!".
Export the function. Then commit with message "feat: add greet function".`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: taskPrompt },
  ];

  let toolCallCount = 0;
  const MAX_ITERATIONS = 15;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n  [Iteration ${i + 1}/${MAX_ITERATIONS}]`);

    const response = await callLLM(messages);

    if (!response.choices || response.choices.length === 0) {
      console.log('  No response from LLM');
      break;
    }

    const choice = response.choices[0];
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Assistant made tool calls
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        console.log(`  [Tool] ${tc.function.name}(${tc.function.arguments.slice(0, 100)}...)`);
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}
        const result = executeTool(tc.function.name, args);
        toolCallCount++;
        console.log(`  [Result] ${result.slice(0, 120)}...`);
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    } else if (msg.content) {
      // Final text response — agent is done
      messages.push({ role: 'assistant', content: msg.content });
      console.log(`  [Agent done] ${msg.content.slice(0, 200)}`);
      break;
    } else {
      console.log(`  [Empty response, finish_reason: ${choice.finish_reason}]`);
      break;
    }
  }

  // Build handoff
  let diff = '';
  let filesChanged = [];
  try {
    diff = execSync('git diff HEAD~1 --no-color', { encoding: 'utf-8', cwd: WORKSPACE });
    filesChanged = execSync('git diff HEAD~1 --name-only', { encoding: 'utf-8', cwd: WORKSPACE })
      .trim().split('\n').filter(Boolean);
  } catch {}

  // Check if greet.ts exists
  let greetExists = false;
  try {
    fs.accessSync('/workspace/repo/src/greet.ts');
    greetExists = true;
  } catch {}

  const handoff = {
    taskId: 'test-lite-001',
    status: greetExists ? 'complete' : 'partial',
    summary: `Agent made ${toolCallCount} tool calls. greet.ts exists: ${greetExists}`,
    filesChanged,
    toolCallCount,
    diff: diff.slice(0, 2000),
  };

  console.log('\n=== HANDOFF ===');
  console.log(JSON.stringify(handoff, null, 2));

  // Write handoff to file so we can read it from outside
  fs.writeFileSync('/workspace/handoff.json', JSON.stringify(handoff, null, 2));
}

main().catch(e => {
  console.error('Agent error:', e.message);
  process.exit(1);
});
"""


def run_test(endpoint: str, model: str):
    """Run the lightweight agent test inside a Modal sandbox."""
    print("\n" + "=" * 60)
    print("LIGHTWEIGHT SANDBOX + LLM TEST")
    print("=" * 60)
    print(f"  Endpoint: {endpoint}")
    print(f"  Model:    {model}")

    app = modal.App.lookup("agentswarm-test", create_if_missing=True)
    image = create_agent_image()

    print("\nCreating sandbox...")
    sb = modal.Sandbox.create(
        "sleep", "infinity",
        app=app,
        image=image,
        timeout=600,
        env={
            "LLM_ENDPOINT": endpoint.rstrip("/"),
            "LLM_MODEL": model,
        },
    )
    print(f"  Sandbox ID: {sb.object_id}")

    try:
        # Step 1: Wait for LLM endpoint to be ready (handles cold start)
        print("\n[Step 1] Waiting for LLM endpoint (cold start may take 1-3 min)...")
        llm_url = endpoint.rstrip("/")
        max_wait = 180  # 3 minutes max
        poll_interval = 10
        deadline = time.time() + max_wait
        ready = False

        while time.time() < deadline:
            elapsed_wait = int(time.time() - (deadline - max_wait))
            check_proc = sb.exec("bash", "-c",
                f'curl -s -o /dev/null -w "%{{http_code}}" --max-time 8 {llm_url}/v1/models'
            )
            status_code = check_proc.stdout.read().strip()
            check_proc.wait()
            print(f"  [{elapsed_wait}s] /v1/models -> {status_code}")

            if status_code == "200":
                ready = True
                break

            remaining = int(deadline - time.time())
            print(f"         Model loading... retrying in {poll_interval}s ({remaining}s remaining)")
            time.sleep(poll_interval)

        if not ready:
            print(f"  ❌ LLM endpoint not ready after {max_wait}s")
            print("     Check: modal app logs agentswarm-test-llm")
            return False

        print("  ✅ LLM endpoint ready")

        # Step 2: Write the agent script into the sandbox
        print("\n[Step 2] Deploying inline agent script...")
        write_proc = sb.exec("bash", "-c",
            f"cat > /workspace/agent.js << 'AGENT_EOF'\n{AGENT_SCRIPT}\nAGENT_EOF"
        )
        write_proc.wait()

        verify_proc = sb.exec("bash", "-c", "wc -c /workspace/agent.js")
        size = verify_proc.stdout.read().strip()
        verify_proc.wait()
        print(f"  Agent script written ({size})")

        # Step 3: Run the agent
        print("\n[Step 3] Running agent (this may take 1-5 minutes)...")
        start = time.time()

        agent_proc = sb.exec("node", "/workspace/agent.js")

        # Stream stdout in real-time
        stdout_lines = []
        for line in agent_proc.stdout:
            line_str = line if isinstance(line, str) else line.decode("utf-8", errors="replace")
            print(f"    {line_str}", end="")
            stdout_lines.append(line_str)

        stderr_text = agent_proc.stderr.read()
        agent_proc.wait()
        elapsed = time.time() - start

        print(f"\n  Agent finished in {elapsed:.1f}s (exit code: {agent_proc.returncode})")

        if stderr_text.strip():
            print(f"  stderr: {stderr_text[:300]}")

        # Step 4: Read the handoff
        print("\n[Step 4] Reading handoff...")
        handoff_proc = sb.exec("cat", "/workspace/handoff.json")
        handoff_raw = handoff_proc.stdout.read()
        handoff_proc.wait()

        try:
            handoff = json.loads(handoff_raw)
            print(f"\n  {'='*50}")
            print(f"  Status:     {handoff.get('status')}")
            print(f"  Summary:    {handoff.get('summary')}")
            print(f"  Files:      {handoff.get('filesChanged', [])}")
            print(f"  Tool calls: {handoff.get('toolCallCount', 0)}")
            if handoff.get('diff'):
                print(f"  Diff preview:\n{handoff['diff'][:400]}")

            if handoff.get("status") == "complete":
                print("\n✅ TEST PASSED: Agent wrote code, committed, produced handoff")
                return True
            else:
                print(f"\n⚠️  Agent returned status: {handoff.get('status')}")
                return False
        except json.JSONDecodeError:
            print(f"  Failed to parse handoff: {handoff_raw[:200]}")
            return False

    finally:
        print("\n  Terminating sandbox...")
        sb.terminate()


def main():
    parser = argparse.ArgumentParser(description="Lightweight Sandbox + LLM Test")
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("LLM_ENDPOINT", ""),
        help="LLM endpoint URL (e.g. https://your-app.modal.run)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("LLM_MODEL", "Qwen/Qwen2.5-Coder-3B-Instruct"),
        help="Model name for the LLM (default: Qwen/Qwen2.5-Coder-3B-Instruct)",
    )
    args = parser.parse_args()

    if not args.endpoint:
        print("❌ --endpoint required")
        print("   Example: python scripts/test_sandbox_lite.py --endpoint https://your-app.modal.run")
        sys.exit(1)

    passed = run_test(args.endpoint, args.model)

    print("\n" + "=" * 60)
    print(f"{'✅ PASSED' if passed else '❌ FAILED'}")
    print("=" * 60)
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
