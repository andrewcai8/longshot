"""
Lightweight LLM endpoint for testing the agent swarm.

Uses Qwen2.5-Coder-3B-Instruct — small enough to fit on a T4 (16GB)
with plenty of headroom for KV cache. Supports OpenAI-compatible
tool calling via the Hermes parser.

Deploy:  modal deploy infra/deploy_test_model.py
Logs:    modal app logs agentswarm-test-llm
Stop:    modal app stop agentswarm-test-llm
"""

import modal
import os
import subprocess
import sys
import time
import urllib.request

app = modal.App("agentswarm-test-llm")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm", "torch")
)

MODEL = "Qwen/Qwen2.5-Coder-3B-Instruct"  # ~6GB VRAM in float16, fits T4 easily


@app.function(
    image=image,
    gpu="T4",
    timeout=1800,
)
@modal.concurrent(max_inputs=4)
@modal.web_server(8000, startup_timeout=300)
def serve():
    # Force UTF-8 to avoid charmap encoding errors in container logs
    os.environ["PYTHONIOENCODING"] = "utf-8"

    cmd = [
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", MODEL,
        "--port", "8000",
        "--enable-auto-tool-choice",
        "--tool-call-parser", "hermes",
        "--max-model-len", "4096",
        "--dtype", "half",
        "--gpu-memory-utilization", "0.85",
    ]
    print(f"Starting vLLM: {' '.join(cmd)}", flush=True)

    proc = subprocess.Popen(
        cmd,
        stdout=sys.stdout,
        stderr=sys.stderr,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )

    # Wait for vLLM to be ready before accepting traffic
    deadline = time.time() + 240
    while time.time() < deadline:
        # Check if process crashed
        if proc.poll() is not None:
            raise RuntimeError(
                f"vLLM exited with code {proc.returncode} — likely OOM. "
                f"Check logs: modal app logs agentswarm-test-llm"
            )
        try:
            resp = urllib.request.urlopen("http://127.0.0.1:8000/v1/models", timeout=3)
            if resp.status == 200:
                data = resp.read().decode()
                print(f"vLLM ready: {data}", flush=True)
                return
        except Exception:
            pass
        time.sleep(5)

    raise RuntimeError("vLLM failed to start within 240s")
