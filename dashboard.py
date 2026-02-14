#!/usr/bin/env python3
"""
AgentSwarm Dashboard -- Rich Terminal UI
=========================================
Real-time monitoring for the massively parallel autonomous coding system.
Reads NDJSON from the TypeScript orchestrator and renders a fullscreen
multi-panel dashboard at 2 Hz.

Usage:
    python dashboard.py --demo                  # synthetic data (no orchestrator needed)
    python dashboard.py --demo --agents 100     # demo with 100 agent slots
    node packages/orchestrator/dist/main.js | python dashboard.py --stdin
    python dashboard.py                         # spawns orchestrator subprocess
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import random
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from typing import Any

try:
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
except ImportError:
    print("Rich library required.  pip install rich")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_ACTIVITY = 50
COST_PER_1K = 0.001          # default $/1K tokens -- override with --cost-rate
GRID_CELL = 3                # chars per grid cell


# ---------------------------------------------------------------------------
# Grid State -- maps tasks to stable visual slots
# ---------------------------------------------------------------------------

class GridState:
    """Fixed-size grid of agent slots.  Tasks are assigned to slots
    round-robin; completed/failed slots are recycled for new tasks."""

    def __init__(self, size: int):
        self.size = size
        # (task_id | "", status)
        self.slots: list[tuple[str, str]] = [("", "idle")] * size
        self._next = 0
        self._index: dict[str, int] = {}          # task_id -> slot

    def assign(self, task_id: str):
        if task_id in self._index:
            self.update(task_id, "running")
            return
        for i in range(self.size):
            idx = (self._next + i) % self.size
            if self.slots[idx][1] in ("idle", "complete", "failed"):
                self.slots[idx] = (task_id, "running")
                self._index[task_id] = idx
                self._next = (idx + 1) % self.size
                return
        # grid full -- overwrite oldest complete/failed
        for i in range(self.size):
            idx = (self._next + i) % self.size
            old_id, old_st = self.slots[idx]
            if old_st in ("complete", "failed"):
                if old_id in self._index:
                    del self._index[old_id]
                self.slots[idx] = (task_id, "running")
                self._index[task_id] = idx
                self._next = (idx + 1) % self.size
                return

    def update(self, task_id: str, status: str):
        idx = self._index.get(task_id)
        if idx is not None:
            self.slots[idx] = (task_id, status)

    def counts(self) -> dict[str, int]:
        c: dict[str, int] = {}
        for _, st in self.slots:
            c[st] = c.get(st, 0) + 1
        return c


# ---------------------------------------------------------------------------
# Shared Dashboard State (thread-safe)
# ---------------------------------------------------------------------------

class DashboardState:
    def __init__(self, max_agents: int, total_features: int, cost_rate: float):
        self._lock = threading.RLock()
        self.start_time = time.time()
        self.cost_rate = cost_rate

        # MetricsSnapshot fields
        self.active_workers = 0
        self.pending_tasks = 0
        self.completed_tasks = 0
        self.failed_tasks = 0
        self.commits_per_hour = 0.0
        self.merge_success_rate = 0.0
        self.total_tokens = 0

        # Grid
        self.grid = GridState(max_agents)
        self.max_agents = max_agents
        self.total_features = total_features

        # Merge
        self.merge_merged = 0
        self.merge_conflicts = 0
        self.merge_failed = 0

        # Activity feed
        self.activity: deque[tuple[str, str, str]] = deque(maxlen=MAX_ACTIVITY)

        # Lines added (cumulative)
        self.lines_added = 0

        # Iteration counter
        self.iteration = 0

    # -- event router -------------------------------------------------------

    def ingest(self, event: dict[str, Any]):
        with self._lock:
            msg = event.get("message", "")
            data = event.get("data") or {}
            level = event.get("level", "info")
            ts = event.get("timestamp", 0)
            ts_str = (
                datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
                if ts
                else time.strftime("%H:%M:%S")
            )

            # -- Metrics snapshot (periodic from Monitor) -------------------
            if msg == "Metrics":
                self.active_workers = data.get("activeWorkers", self.active_workers)
                self.pending_tasks = data.get("pendingTasks", self.pending_tasks)
                self.completed_tasks = data.get("completedTasks", self.completed_tasks)
                self.failed_tasks = data.get("failedTasks", self.failed_tasks)
                self.commits_per_hour = data.get("commitsPerHour", self.commits_per_hour)
                self.merge_success_rate = data.get("mergeSuccessRate", self.merge_success_rate)
                self.total_tokens = data.get("totalTokensUsed", self.total_tokens)

            # -- Per-task lifecycle (from wired TaskQueue.onStatusChange) ----
            elif msg == "Task status":
                task_id = data.get("taskId", "")
                new_st = data.get("to", "")
                if task_id and new_st:
                    if new_st in ("assigned", "running"):
                        self.grid.assign(task_id)
                    else:
                        self.grid.update(task_id, new_st)

            # -- Task created (from Planner callback) -----------------------
            elif msg == "Task created":
                task_id = data.get("taskId", "")
                desc = data.get("desc", "")
                if task_id:
                    self.grid.assign(task_id)
                self._feed(ts_str, f"  + {task_id}  {desc[:52]}", "cyan")

            # -- Task completed ---------------------------------------------
            elif msg == "Task completed":
                task_id = data.get("taskId", "")
                status = data.get("status", "")
                final = "complete" if status == "complete" else "failed"
                if task_id:
                    self.grid.update(task_id, final)
                style = "green" if final == "complete" else "red"
                self._feed(ts_str, f"  {task_id}  {status}", style)

            # -- Worker dispatched ------------------------------------------
            elif msg == "Dispatching task to ephemeral sandbox":
                task_id = data.get("taskId", "")
                if task_id:
                    self.grid.assign(task_id)

            # -- Merge results (from new planner logging) -------------------
            elif msg == "Merge result":
                status = data.get("status", "")
                branch = data.get("branch", "")[:30]
                if status == "merged":
                    self.merge_merged += 1
                    self._feed(ts_str, f"  >> merged  {branch}", "green")
                elif status == "conflict":
                    self.merge_conflicts += 1
                    self._feed(ts_str, f"  !! conflict  {branch}", "yellow")
                else:
                    self.merge_failed += 1
                    self._feed(ts_str, f"  xx merge fail  {branch}", "red")

            # -- Iteration --------------------------------------------------
            elif msg == "Iteration complete":
                self.iteration = data.get("iteration", self.iteration)
                n = data.get("tasks", 0)
                self.active_workers = data.get("activeWorkers", self.active_workers)
                self.completed_tasks = data.get("completedTasks", self.completed_tasks)
                self._feed(ts_str, f"  -- iteration {self.iteration}  ({n} tasks)", "blue")

            # -- Reconciler -------------------------------------------------
            elif msg == "Reconciler created fix tasks":
                c = data.get("count", 0)
                self._feed(ts_str, f"  reconciler  {c} fix tasks", "yellow")

            elif msg == "Sweep check results":
                ok = data.get("buildOk") and data.get("testsOk")
                label = "all green" if ok else "NEEDS FIX"
                self._feed(ts_str, f"  sweep: {label}", "green" if ok else "red")

            # -- Timeouts / errors ------------------------------------------
            elif msg == "Worker timed out":
                tid = data.get("taskId", "")
                if tid:
                    self.grid.update(tid, "failed")
                self._feed(ts_str, f"  TIMEOUT  {tid}", "bold red")

            elif level == "error":
                self._feed(ts_str, f"  ERR  {msg[:60]}", "bold red")

    def _feed(self, ts: str, msg: str, style: str):
        self.activity.appendleft((ts, msg, style))

    # -- snapshot for renderers ---------------------------------------------

    def snap(self) -> dict[str, Any]:
        with self._lock:
            elapsed = time.time() - self.start_time
            total_merge = self.merge_merged + self.merge_conflicts + self.merge_failed
            return {
                "elapsed": elapsed,
                "active": self.active_workers,
                "pending": self.pending_tasks,
                "completed": self.completed_tasks,
                "failed": self.failed_tasks,
                "cph": self.commits_per_hour,
                "merge_rate": self.merge_success_rate,
                "tokens": self.total_tokens,
                "cost": self.total_tokens / 1000.0 * self.cost_rate,
                "slots": list(self.grid.slots),
                "max_agents": self.max_agents,
                "total_features": self.total_features,
                "merge_merged": self.merge_merged,
                "merge_conflicts": self.merge_conflicts,
                "merge_failed": self.merge_failed,
                "merge_total": total_merge,
                "activity": list(self.activity),
                "iteration": self.iteration,
                "grid_counts": self.grid.counts(),
            }


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

def make_layout() -> Layout:
    root = Layout(name="root")
    root.split_column(
        Layout(name="header", size=3),
        Layout(name="body", ratio=1),
        Layout(name="footer", size=3),
    )
    root["body"].split_row(
        Layout(name="left", size=30, minimum_size=26),
        Layout(name="right", ratio=1, minimum_size=40),
    )
    root["left"].split_column(
        Layout(name="metrics", ratio=1),
        Layout(name="merge", size=9),
    )
    root["right"].split_column(
        Layout(name="grid", ratio=1),
        Layout(name="activity", size=14),
    )
    return root


# ---------------------------------------------------------------------------
# Panel renderers
# ---------------------------------------------------------------------------

def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _elapsed_str(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def render_header(s: dict[str, Any]) -> Panel:
    tbl = Table.grid(expand=True)
    tbl.add_column(justify="left", ratio=1)
    tbl.add_column(justify="center", ratio=1)
    tbl.add_column(justify="right", ratio=1)

    elapsed = _elapsed_str(s["elapsed"])
    active = s["active"]
    mx = s["max_agents"]
    cph = s["cph"]

    tbl.add_row(
        f"[bold bright_cyan]AGENTSWARM[/]  [dim]{elapsed}[/]",
        f"[bold bright_white]{active}[/][dim]/{mx} agents[/]",
        f"[bold bright_green]{cph:,.0f}[/] [dim]commits/hr[/]",
    )
    return Panel(tbl, style="bright_cyan", height=3)


def render_metrics(s: dict[str, Any]) -> Panel:
    tbl = Table(show_header=False, box=None, padding=(0, 1), expand=True)
    tbl.add_column("k", style="dim", no_wrap=True, width=13)
    tbl.add_column("v", justify="right")

    done = s["completed"]
    total = s["total_features"]
    pct = done / total * 100 if total else 0
    rate = s["merge_rate"]
    rate_color = "bright_green" if rate > 0.9 else "yellow" if rate > 0.7 else "bright_red"

    tbl.add_row("Iteration",   f"[bright_white]{s['iteration']}[/]")
    tbl.add_row("Commits/hr",  f"[bright_green]{s['cph']:,.0f}[/]")
    tbl.add_row("Tasks done",  f"[bright_green]{done}[/][dim]/{total}  {pct:.0f}%[/]")
    tbl.add_row("Failed",      f"[bright_red]{s['failed']}[/]" if s['failed'] else "[dim]0[/]")
    tbl.add_row("Pending",     f"[yellow]{s['pending']}[/]" if s['pending'] else "[dim]0[/]")
    tbl.add_row("Merge rate",  f"[{rate_color}]{rate * 100:.1f}%[/]")
    tbl.add_row("Tokens",      f"[bright_cyan]{_fmt_tokens(s['tokens'])}[/]")
    tbl.add_row("Est. cost",   f"[bright_cyan]${s['cost']:.2f}[/]")

    return Panel(tbl, title="[bold]METRICS[/]", border_style="bright_blue")


def render_grid(s: dict[str, Any]) -> Panel:
    slots = s["slots"]
    n = len(slots)
    cols = max(1, min(20, int(math.ceil(math.sqrt(n)))))
    rows_needed = max(1, int(math.ceil(n / cols)))

    cell_map = {
        "idle":     ("[bright_black]\u2591\u2591\u2591[/]"),
        "pending":  ("[blue]\u2592\u2592\u2592[/]"),
        "assigned": ("[cyan]\u2593\u2593\u2593[/]"),
        "running":  ("[bold bright_yellow]\u2588\u2588\u2588[/]"),
        "complete": ("[bright_green]\u2588\u2588\u2588[/]"),
        "failed":   ("[bright_red]\u2588\u2588\u2588[/]"),
    }

    grid = Table(show_header=False, box=None, padding=(0, 1), expand=True)
    for _ in range(cols):
        grid.add_column(width=GRID_CELL, justify="center", no_wrap=True)

    for r in range(rows_needed):
        cells: list[str] = []
        for c in range(cols):
            idx = r * cols + c
            if idx < n:
                _, st = slots[idx]
                cells.append(cell_map.get(st, cell_map["idle"]))
            else:
                cells.append("   ")
        grid.add_row(*cells)

    # legend + counts
    gc = s["grid_counts"]
    legend = Text()
    legend.append(" \u2588\u2588 ", style="bold bright_yellow")
    legend.append(f"{gc.get('running', 0):>3} active  ", style="dim")
    legend.append(" \u2588\u2588 ", style="bright_green")
    legend.append(f"{gc.get('complete', 0):>3} done  ", style="dim")
    legend.append(" \u2588\u2588 ", style="bright_red")
    legend.append(f"{gc.get('failed', 0):>3} fail  ", style="dim")
    legend.append(" \u2591\u2591 ", style="bright_black")
    legend.append(f"{gc.get('idle', 0):>3} idle", style="dim")

    wrap = Table.grid(expand=True)
    wrap.add_row(grid)
    wrap.add_row(legend)

    return Panel(wrap, title="[bold]AGENT GRID[/]", border_style="bright_yellow")


def render_merge(s: dict[str, Any]) -> Panel:
    rate = s["merge_rate"]
    bar_w = 20
    filled = int(rate * bar_w) if s["merge_total"] > 0 else 0
    bar = (
        "[bright_green]" + "\u2588" * filled + "[/]"
        + "[bright_black]" + "\u2591" * (bar_w - filled) + "[/]"
    )
    pct = f"{rate * 100:.0f}%" if s["merge_total"] > 0 else " -- "

    tbl = Table(show_header=False, box=None, padding=(0, 1), expand=True)
    tbl.add_column("k", style="dim", no_wrap=True, width=11)
    tbl.add_column("v", justify="right")
    tbl.add_row("Success", f"{bar} {pct}")
    tbl.add_row("Merged",    f"[bright_green]{s['merge_merged']}[/]")
    tbl.add_row("Conflicts",
                f"[yellow]{s['merge_conflicts']}[/]" if s['merge_conflicts'] else "[dim]0[/]")
    tbl.add_row("Failed",
                f"[bright_red]{s['merge_failed']}[/]" if s['merge_failed'] else "[dim]0[/]")

    return Panel(tbl, title="[bold]MERGE QUEUE[/]", border_style="bright_magenta")


def render_activity(s: dict[str, Any]) -> Panel:
    txt = Text()
    for ts_str, msg, style in s["activity"]:
        txt.append(f" {ts_str}", style="dim")
        txt.append(f"{msg}\n", style=style)
    if not s["activity"]:
        txt.append("  waiting for events ...", style="dim italic")
    return Panel(txt, title="[bold]ACTIVITY[/]", border_style="bright_green")


def render_footer(s: dict[str, Any]) -> Panel:
    done = s["completed"]
    total = s["total_features"]
    pct = done / total if total else 0
    bar_w = 50
    filled = int(pct * bar_w)
    bar = (
        "[bold bright_green]" + "\u2588" * filled + "[/]"
        + "[bright_black]" + "\u2591" * (bar_w - filled) + "[/]"
    )
    txt = Text.from_markup(
        f"  [bold]FEATURES[/]  {bar}  [bright_white]{done}[/]"
        f"[dim]/{total}[/]  [bright_cyan]{pct * 100:.0f}%[/]"
    )
    return Panel(txt, style="bright_cyan", height=3)


# ---------------------------------------------------------------------------
# NDJSON readers
# ---------------------------------------------------------------------------

def reader_subprocess(cmd: list[str], q: queue.Queue[Any], cwd: str):
    """Spawn orchestrator process, read NDJSON lines from stdout."""
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, cwd=cwd, env={**os.environ},
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                q.put(json.loads(line))
            except json.JSONDecodeError:
                pass
        proc.wait()
    except Exception as exc:
        q.put({
            "level": "error", "message": f"Process error: {exc}",
            "timestamp": int(time.time() * 1000),
        })
    finally:
        q.put(None)


def reader_stdin(q: queue.Queue[Any]):
    """Read NDJSON from stdin (pipe mode)."""
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                q.put(json.loads(line))
            except json.JSONDecodeError:
                pass
    finally:
        q.put(None)


# ---------------------------------------------------------------------------
# Demo data generator
# ---------------------------------------------------------------------------

_DEMO_DESCS = [
    "Implement chunk meshing system",
    "Add block face culling",
    "Create player controller",
    "Setup WebGL2 renderer",
    "Build terrain noise generator",
    "Add skybox shader",
    "Implement block placement",
    "Create inventory UI overlay",
    "Add ambient occlusion",
    "Build water flow simulation",
    "Setup collision detection",
    "Create world save/load",
    "Add fog distance shader",
    "Implement biome blending",
    "Build particle system",
    "Add block breaking animation",
    "Create crafting grid UI",
    "Implement greedy meshing",
    "Add texture atlas packer",
    "Build chunk LOD system",
    "Setup audio manager",
    "Create main menu screen",
    "Add day/night cycle",
    "Implement frustum culling",
    "Build entity component system",
]


def demo_generator(q: queue.Queue[Any], max_agents: int, total_features: int):
    """Generate synthetic orchestrator events for demo mode."""
    start = time.time()
    task_n = 0
    done = 0
    failed = 0
    merged = 0
    conflicts = 0
    iteration = 0
    tokens = 0
    active: dict[str, float] = {}

    try:
        while done + failed < total_features:
            now = time.time()
            elapsed = now - start
            ts = int(now * 1000)

            ramp = min(1.0, elapsed / 25.0)
            target = int(max_agents * ramp)

            # -- complete some running tasks --------------------------------
            for tid, started in list(active.items()):
                dur = random.uniform(2.5, 10.0)
                if now - started > dur:
                    ok = random.random() < 0.92
                    status = "complete" if ok else "failed"
                    tok = random.randint(3000, 18000)
                    tokens += tok

                    if ok:
                        done += 1
                    else:
                        failed += 1

                    q.put({"timestamp": ts, "level": "info", "agentId": "main",
                           "agentRole": "root-planner", "message": "Task completed",
                           "data": {"taskId": tid, "status": status}})
                    q.put({"timestamp": ts, "level": "info", "agentId": "main",
                           "agentRole": "root-planner", "message": "Task status",
                           "data": {"taskId": tid, "from": "running", "to": status}})

                    # merge
                    if ok:
                        if random.random() < 0.94:
                            merged += 1
                            q.put({"timestamp": ts, "level": "info",
                                   "agentId": "planner", "agentRole": "root-planner",
                                   "message": "Merge result",
                                   "data": {"branch": f"worker/{tid}", "status": "merged",
                                            "success": True}})
                        else:
                            conflicts += 1
                            q.put({"timestamp": ts, "level": "warn",
                                   "agentId": "planner", "agentRole": "root-planner",
                                   "message": "Merge result",
                                   "data": {"branch": f"worker/{tid}", "status": "conflict",
                                            "success": False}})
                    del active[tid]

            # -- spawn new tasks to fill slots ------------------------------
            while len(active) < target and task_n < total_features:
                task_n += 1
                tid = f"task-{task_n:03d}"
                desc = random.choice(_DEMO_DESCS)

                q.put({"timestamp": ts, "level": "info", "agentId": "main",
                       "agentRole": "root-planner", "message": "Task created",
                       "data": {"taskId": tid, "desc": desc}})
                q.put({"timestamp": ts, "level": "info", "agentId": "worker-pool",
                       "agentRole": "root-planner",
                       "message": "Dispatching task to ephemeral sandbox",
                       "data": {"taskId": tid}})
                q.put({"timestamp": ts, "level": "info", "agentId": "main",
                       "agentRole": "root-planner", "message": "Task status",
                       "data": {"taskId": tid, "from": "pending", "to": "running"}})
                active[tid] = now

            # -- periodic metrics -------------------------------------------
            if random.random() < 0.35:
                eh = max(elapsed / 3600, 0.001)
                ma = merged + conflicts
                q.put({"timestamp": ts, "level": "info",
                       "agentId": "monitor", "agentRole": "root-planner",
                       "message": "Metrics",
                       "data": {
                           "timestamp": ts,
                           "activeWorkers": len(active),
                           "pendingTasks": max(0, task_n - done - failed - len(active)),
                           "completedTasks": done,
                           "failedTasks": failed,
                           "commitsPerHour": done / eh,
                           "mergeSuccessRate": merged / ma if ma else 0,
                           "totalTokensUsed": tokens,
                           "totalCostUsd": 0,
                       }})

            # -- iteration events -------------------------------------------
            if done > 0 and done % 15 == 0 and random.random() < 0.4:
                iteration += 1
                q.put({"timestamp": ts, "level": "info",
                       "agentId": "main", "agentRole": "root-planner",
                       "message": "Iteration complete",
                       "data": {"iteration": iteration, "tasks": random.randint(8, 20),
                                "handoffs": random.randint(8, 20),
                                "activeWorkers": len(active),
                                "completedTasks": done}})

            # -- occasional reconciler sweep --------------------------------
            if random.random() < 0.015:
                b = random.random() < 0.85
                t = random.random() < 0.80
                q.put({"timestamp": ts, "level": "info",
                       "agentId": "reconciler", "agentRole": "reconciler",
                       "message": "Sweep check results",
                       "data": {"buildOk": b, "testsOk": t}})
                if not (b and t):
                    fc = random.randint(1, 3)
                    q.put({"timestamp": ts, "level": "info",
                           "agentId": "main", "agentRole": "root-planner",
                           "message": "Reconciler created fix tasks",
                           "data": {"count": fc}})

            time.sleep(0.25)
    finally:
        q.put(None)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="AgentSwarm Rich Terminal Dashboard")
    ap.add_argument("--demo", action="store_true", help="Synthetic data mode")
    ap.add_argument("--stdin", action="store_true", help="Read NDJSON from stdin")
    ap.add_argument("--agents", type=int, default=100, help="Max agent slots (default 100)")
    ap.add_argument("--features", type=int, default=200, help="Total features (default 200)")
    ap.add_argument("--hz", type=int, default=2, help="Refresh rate Hz (default 2)")
    ap.add_argument("--cost-rate", type=float, default=COST_PER_1K,
                    help="$/1K tokens for cost estimate")
    args = ap.parse_args()

    console = Console()
    state = DashboardState(args.agents, args.features, args.cost_rate)
    dq: queue.Queue[Any] = queue.Queue()

    # start reader thread
    if args.demo:
        thr = threading.Thread(target=demo_generator,
                               args=(dq, args.agents, args.features), daemon=True)
    elif args.stdin:
        thr = threading.Thread(target=reader_stdin, args=(dq,), daemon=True)
    else:
        cwd = os.path.dirname(os.path.abspath(__file__))
        thr = threading.Thread(
            target=reader_subprocess,
            args=(["node", "packages/orchestrator/dist/main.js"], dq, cwd),
            daemon=True,
        )
    thr.start()

    layout = make_layout()

    try:
        with Live(layout, console=console, refresh_per_second=args.hz, screen=True):
            running = True
            while running:
                # drain queue
                batch = 0
                while batch < 200:           # cap per tick to keep UI responsive
                    try:
                        item = dq.get_nowait()
                        if item is None:
                            running = False
                            break
                        state.ingest(item)
                        batch += 1
                    except queue.Empty:
                        break

                # render
                s = state.snap()
                layout["header"].update(render_header(s))
                layout["metrics"].update(render_metrics(s))
                layout["grid"].update(render_grid(s))
                layout["merge"].update(render_merge(s))
                layout["activity"].update(render_activity(s))
                layout["footer"].update(render_footer(s))

                time.sleep(1.0 / args.hz)

    except KeyboardInterrupt:
        pass

    # final summary
    s = state.snap()
    console.print()
    console.print("[bold bright_cyan]AgentSwarm Session Complete[/]")
    console.print(f"  Duration    {timedelta(seconds=int(s['elapsed']))}")
    console.print(f"  Completed   {s['completed']} / {s['total_features']}")
    console.print(f"  Failed      {s['failed']}")
    console.print(f"  Merged      {s['merge_merged']}  "
                  f"conflicts {s['merge_conflicts']}  "
                  f"failed {s['merge_failed']}")
    console.print(f"  Tokens      {s['tokens']:,}")
    console.print(f"  Est. cost   ${s['cost']:.2f}")
    console.print()


if __name__ == "__main__":
    main()
