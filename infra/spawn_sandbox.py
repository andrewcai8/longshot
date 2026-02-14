"""
Sandbox Manager — Orchestrator-side sandbox lifecycle management
================================================================

Creates Modal sandboxes, deploys the coding agent, sends tasks,
polls for completion, and collects handoff reports.

Usage:
    from infra.spawn_sandbox import SandboxManager
    
    manager = SandboxManager()
    result = await manager.run_task({
        "id": "task-001",
        "description": "Implement a hello world function",
        "scope": ["src/hello.ts"],
        "acceptance": "Function exists and returns 'Hello, World!'",
        "branch": "worker/task-001",
        ...
    })
    print(result)  # Handoff dict
"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import aiohttp
import modal

from infra.sandbox_image import create_agent_image


@dataclass
class SandboxInfo:
    """Tracks a running sandbox."""
    sandbox_id: str
    sandbox: modal.Sandbox
    url: str  # HTTP tunnel URL
    task_id: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    status: str = "starting"


class SandboxManager:
    """
    Manages the lifecycle of Modal sandboxes for coding agents.
    
    Each sandbox runs the @agentswarm/sandbox HTTP server which:
    - Accepts POST /task with a TaskAssignment
    - Runs the LLM-powered coding agent
    - Returns a TaskResult with handoff
    - Reports health at GET /health
    """
    
    def __init__(
        self,
        app_name: str = "agentswarm",
        timeout: int = 1800,        # 30 min max per sandbox
        idle_timeout: int = 300,     # 5 min idle before auto-terminate
        agent_port: int = 8080,
        poll_interval: int = 10,     # seconds between health checks
    ):
        self.app = modal.App.lookup(app_name, create_if_missing=True)
        self.image = create_agent_image()
        self.timeout = timeout
        self.idle_timeout = idle_timeout
        self.agent_port = agent_port
        self.poll_interval = poll_interval
        self.active_sandboxes: dict[str, SandboxInfo] = {}
    
    async def create_sandbox(self) -> SandboxInfo:
        """
        Create a new Modal sandbox with the agent image.
        Starts the agent HTTP server inside it.
        Returns SandboxInfo with the tunnel URL.
        """
        sandbox_id = f"sb-{uuid.uuid4().hex[:12]}"
        
        # Create sandbox — run the agent server as entrypoint
        # The server.ts compiled output is at /agent/packages/sandbox/dist/server.js
        sandbox = modal.Sandbox.create(
            # Start with sleep, then we exec the server
            "sleep", "infinity",
            app=self.app,
            image=self.image,
            timeout=self.timeout,
            idle_timeout=self.idle_timeout,
            encrypted_ports=[self.agent_port],
            env={
                "PORT": str(self.agent_port),
                "SANDBOX_ID": sandbox_id,
                "NODE_ENV": "production",
            },
        )
        
        # Start the agent HTTP server inside the sandbox
        proc = sandbox.exec(
            "node", "/agent/packages/sandbox/dist/server.js",
            background=True,
        )
        
        # Wait for tunnel URL
        tunnels = sandbox.tunnels(timeout=60)
        tunnel = tunnels[self.agent_port]
        url = tunnel.url
        
        info = SandboxInfo(
            sandbox_id=sandbox_id,
            sandbox=sandbox,
            url=url,
        )
        self.active_sandboxes[sandbox_id] = info
        
        # Wait for server to be ready
        await self._wait_for_ready(info, timeout=60)
        info.status = "ready"
        
        return info
    
    async def _wait_for_ready(self, info: SandboxInfo, timeout: int = 60) -> None:
        """Poll the health endpoint until the server is ready."""
        deadline = time.time() + timeout
        async with aiohttp.ClientSession() as session:
            while time.time() < deadline:
                try:
                    async with session.get(
                        f"{info.url}/health",
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status == 200:
                            return
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    pass
                await asyncio.sleep(2)
        raise TimeoutError(f"Sandbox {info.sandbox_id} failed to start within {timeout}s")
    
    async def send_task(
        self,
        info: SandboxInfo,
        task: dict,
        system_prompt: str,
        llm_config: dict,
        repo_url: Optional[str] = None,
    ) -> dict:
        """
        Send a task to a sandbox and wait for completion.
        
        Args:
            info: SandboxInfo from create_sandbox()
            task: Task dict matching the Task interface from core/types.ts
            system_prompt: The worker.md prompt content
            llm_config: { endpoint, model, maxTokens, temperature }
            repo_url: Git repo URL to clone into the sandbox (optional)
        
        Returns:
            Handoff dict from the agent
        """
        info.task_id = task["id"]
        info.status = "working"
        
        # Clone repo if URL provided
        if repo_url:
            clone_proc = info.sandbox.exec(
                "git", "clone", "--depth", "1", repo_url, "/workspace/repo",
            )
            clone_proc.wait()
            
            # Create and checkout task branch
            branch = task.get("branch", f"worker/{task['id']}")
            branch_proc = info.sandbox.exec(
                "bash", "-c",
                f"cd /workspace/repo && git checkout -b {branch}",
            )
            branch_proc.wait()
        
        # Build the TaskAssignment payload
        assignment = {
            "type": "task_assignment",
            "task": task,
            "systemPrompt": system_prompt,
            "repoSnapshot": repo_url or "",
            "llmConfig": llm_config,
        }
        
        # Send task to the agent
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{info.url}/task",
                json=assignment,
                timeout=aiohttp.ClientTimeout(total=self.timeout),
            ) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(
                        f"Task submission failed ({resp.status}): {error_body}"
                    )
                result = await resp.json()
        
        info.status = "completing"
        
        # Extract handoff from result
        handoff = result.get("handoff", result)
        return handoff
    
    async def check_health(self, info: SandboxInfo) -> Optional[dict]:
        """Check sandbox health. Returns health dict or None if unreachable."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{info.url}/health",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status == 200:
                        return await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError):
            pass
        return None
    
    async def terminate_sandbox(self, sandbox_id: str) -> None:
        """Terminate a sandbox and remove it from tracking."""
        info = self.active_sandboxes.get(sandbox_id)
        if info:
            try:
                info.sandbox.terminate()
            except Exception:
                pass  # Already terminated
            info.status = "terminated"
            del self.active_sandboxes[sandbox_id]
    
    async def terminate_all(self) -> None:
        """Terminate all active sandboxes."""
        sandbox_ids = list(self.active_sandboxes.keys())
        for sid in sandbox_ids:
            await self.terminate_sandbox(sid)
    
    async def run_task(
        self,
        task: dict,
        system_prompt: str,
        llm_config: dict,
        repo_url: Optional[str] = None,
    ) -> dict:
        """
        High-level: create sandbox, send task, collect result, terminate.
        
        This is the main entry point for running a single task.
        Returns the handoff dict.
        """
        info = None
        try:
            # Create sandbox
            info = await self.create_sandbox()
            print(f"[SandboxManager] Created sandbox {info.sandbox_id} at {info.url}")
            
            # Run the task
            handoff = await self.send_task(
                info=info,
                task=task,
                system_prompt=system_prompt,
                llm_config=llm_config,
                repo_url=repo_url,
            )
            print(f"[SandboxManager] Task {task['id']} completed: {handoff.get('status', 'unknown')}")
            
            return handoff
            
        except Exception as e:
            print(f"[SandboxManager] Error running task {task.get('id', '?')}: {e}")
            return {
                "taskId": task.get("id", "unknown"),
                "status": "failed",
                "summary": f"Sandbox error: {str(e)}",
                "diff": "",
                "filesChanged": [],
                "concerns": [str(e)],
                "suggestions": ["Check sandbox logs", "Retry the task"],
                "metrics": {
                    "linesAdded": 0,
                    "linesRemoved": 0,
                    "filesCreated": 0,
                    "filesModified": 0,
                    "tokensUsed": 0,
                    "toolCallCount": 0,
                    "durationMs": 0,
                },
            }
        finally:
            if info:
                await self.terminate_sandbox(info.sandbox_id)


# =============================================================================
# CLI: Test single sandbox
# =============================================================================

async def _test():
    """Quick test: create a sandbox, check health, terminate."""
    manager = SandboxManager()
    
    print("Creating sandbox...")
    info = await manager.create_sandbox()
    print(f"Sandbox ready: {info.sandbox_id} at {info.url}")
    
    health = await manager.check_health(info)
    print(f"Health: {json.dumps(health, indent=2)}")
    
    print("Terminating...")
    await manager.terminate_sandbox(info.sandbox_id)
    print("Done!")


if __name__ == "__main__":
    asyncio.run(_test())
