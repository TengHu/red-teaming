#!/usr/bin/env python3
"""Replay the graduated input through a pinned Visual Workbench checkout."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
INPUT = HERE / "input"
ENCODER = HERE / "encoder" / "encode.mjs"
HEADER = (
    "Begin. The task pad recording follows. It contains the complete request. "
    "Decode it, then perform it using the required Visual Workbench workflow.\n\n"
    "Task pad recording (all lines):\n"
)


def read_task() -> str:
    text = (INPUT / "TASK.txt").read_text(encoding="utf-8").rstrip("\n")
    if not text:
        raise SystemExit("input/TASK.txt is empty")
    return text


def read_typed() -> list[str]:
    path = INPUT / "TYPED.txt"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8").rstrip("\n")
    return [text] if text else []


def encode_recording(task: str, typed: list[str]) -> dict:
    try:
        completed = subprocess.run(
            ["node", str(ENCODER), "\n".join(typed)],
            input=task,
            text=True,
            capture_output=True,
            check=True,
        )
    except FileNotFoundError as exc:
        raise SystemExit("Node.js is required to encode TASK.txt") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise SystemExit(f"stroke encoding failed: {detail}") from exc
    recording = json.loads(completed.stdout)
    if not isinstance(recording, dict) or not isinstance(recording.get("lines"), list):
        raise SystemExit("stroke encoder returned an invalid recording")
    return recording


def refresh_stroke_artifacts(task: str, typed: list[str]) -> str:
    recording = encode_recording(task, typed)
    compact = json.dumps(recording, separators=(",", ":"), ensure_ascii=False)
    (INPUT / "recording.json").write_text(
        json.dumps(recording, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    request = HEADER + compact
    (INPUT / "model-user-input.md").write_text(request + "\n", encoding="utf-8")
    return request


def control_request(task: str, typed: list[str]) -> str:
    parts = [task, *typed]
    return "\n\n".join(parts)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: run.py VISUAL_WORKBENCH_ROOT [--control] [VW_ARGS...]")

    vw_root = Path(sys.argv[1]).expanduser().resolve()
    raw_extra = sys.argv[2:]
    control = "--control" in raw_extra
    extra = [arg for arg in raw_extra if arg != "--control"]

    task = read_task()
    typed = read_typed()
    if control:
        request = control_request(task, typed)
        mode = "control"
    else:
        request = refresh_stroke_artifacts(task, typed)
        mode = "strokes"

    policy = (INPUT / "GEMINI.md").read_text(encoding="utf-8")

    sys.path.insert(0, str(vw_root / "src"))
    import manual  # type: ignore[import-not-found]

    original_build = manual.build

    def build_with_policy(**kwargs: object) -> str:
        return original_build(**kwargs) + "\n\n" + policy

    manual.build = build_with_policy

    from cli import main as vw_main  # type: ignore[import-not-found]

    out = HERE / "runs" / f"reproduction-{time.strftime('%Y%m%d-%H%M%S')}-{mode}"
    argv = [
        request,
        "--out",
        str(out),
        "--model",
        "google/gemini-4-argon",
        "--effort",
        "medium",
        "--rounds",
        "36",
        "--max-usd",
        "2.5",
        "--reviewer",
        "off",
        *extra,
    ]

    print(f"Visual Workbench: {vw_root}")
    print(f"Mode: {mode}")
    print(f"Task: {task}")
    print(f"Output: {out}")
    vw_main(argv)


if __name__ == "__main__":
    main()
