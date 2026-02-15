#!/usr/bin/env python3
"""
Gource Adapter for AgentSwarm
=============================
Reads AgentSwarm NDJSON events from stdin and outputs Gource Custom Log Format.

Format: timestamp|username|type|file|color

Usage:
    python3 dashboard.py --json-only | python3 gource-adapter.py | gource --log-format custom -
"""

import sys
import json
import time

# Map taskId -> parentId to reconstruct full paths
TASK_PARENTS = {}

def get_color(msg):
    """Return hex color (no #) for event type."""
    msg = msg.lower()
    if "created" in msg or "spawned" in msg:
        return "00FF00" # Green
    if "completed" in msg or "success" in msg:
        return "00AAFF" # Blue
    if "failed" in msg or "error" in msg:
        return "FF0000" # Red
    if "merge" in msg:
        return "AA00FF" # Purple
    return "FFFFFF" # White

def build_path(task_id, role_group):
    """Recursively build path walking up the parent tree."""
    parts = []

    # 1. Walk up to root
    curr = task_id
    while curr:
        parts.insert(0, curr)
        curr = TASK_PARENTS.get(curr)
        # Safety break for loops or too deep
        if len(parts) > 10:
            break

    # 2. Add role group prefix
    # swarm / {role} / {grandparent} / {parent} / {task}
    return f"swarm/{role_group}/{'/'.join(parts)}"

def process_line(line):
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return

    # 1. Timestamp (seconds)
    ts_ms = event.get("timestamp")
    if ts_ms:
        ts = int(ts_ms / 1000)
    else:
        ts = int(time.time())

    msg = event.get("message", "")
    data = event.get("data") or {}

    # 2. Extract Entities
    task_id = str(data.get("taskId") or event.get("taskId") or "")
    agent_role = event.get("agentRole", "System")
    role_group = f"{agent_role}s"

    # 3. Update Genealogy (Track Parents)
    parent_id = data.get("parentId") or data.get("parentTaskId")
    if task_id and parent_id:
        TASK_PARENTS[task_id] = parent_id

    # 4. Determine User
    user = agent_role
    if task_id.startswith("agent-"):
        user = task_id.split("-sub-")[0]

    if not user or user == "System":
        user = "Orchestrator"

    # 5. Determine File Path (Full Ancestry)
    if task_id:
        path = build_path(task_id, role_group)
    else:
        path = f"swarm/{role_group}/orchestrator_log"

    # 6. Determine Action
    action = "M"
    if msg == "Task created" or msg == "Worker dispatched" or "spawned" in msg:
        action = "A"

    # 7. Color
    color = get_color(msg)

    # Sanitize
    user = str(user).replace("|", "")
    path = str(path).replace("|", "")

    print(f"{ts}|{user}|{action}|{path}|{color}")
    sys.stdout.flush()

def main():
    try:
        for line in sys.stdin:
            if not line: break
            process_line(line)
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
