#!/usr/bin/env python3
"""
OpenHands bridge.

Recursive's control loop is TypeScript; the OpenHands Software Agent SDK is
Python. Rather than guess at REST endpoint shapes, this bridge drives the
documented Python API directly and speaks JSON over stdin/stdout.

Contract:
    stdin  <- {"prompt": str, "repoPath": str, "model": str, "baseUrl": str|null,
               "apiKeyEnv": str, "maxIterations": int}
    stdout -> {"summary": str, "turns": int, "ok": bool, "error": str|null}

Install:
    pip install openhands

Why this engine exists: it is MIT-licensed and model-agnostic, so a customer who
cannot let source or prompts leave their network can point `baseUrl` at a locally
hosted model and run the entire fix stage inside their own perimeter.
"""

import json
import os
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        emit({"summary": "", "turns": 0, "ok": False, "error": f"bad request: {exc}"})
        return 1

    try:
        from openhands.sdk import LLM, Agent, Conversation, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.task_tracker import TaskTrackerTool
        from openhands.tools.terminal import TerminalTool
    except ImportError as exc:
        emit(
            {
                "summary": "",
                "turns": 0,
                "ok": False,
                "error": (
                    f"openhands SDK not importable ({exc}). "
                    "Install it with `pip install openhands`."
                ),
            }
        )
        return 1

    api_key = os.getenv(request.get("apiKeyEnv") or "LLM_API_KEY")
    if not api_key and not request.get("baseUrl"):
        emit(
            {
                "summary": "",
                "turns": 0,
                "ok": False,
                "error": (
                    "No model credentials. Set the env var named by apiKeyEnv, or "
                    "point baseUrl at a self-hosted model that needs no key."
                ),
            }
        )
        return 1

    llm_kwargs = {"model": request["model"]}
    if api_key:
        llm_kwargs["api_key"] = api_key
    if request.get("baseUrl"):
        llm_kwargs["base_url"] = request["baseUrl"]

    try:
        llm = LLM(**llm_kwargs)
        agent = Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name),
                Tool(name=FileEditorTool.name),
                Tool(name=TaskTrackerTool.name),
            ],
        )
        conversation = Conversation(agent=agent, workspace=request["repoPath"])
        conversation.send_message(request["prompt"])
        conversation.run()
    except Exception as exc:  # noqa: BLE001
        emit({"summary": "", "turns": 0, "ok": False, "error": f"agent run failed: {exc}"})
        return 1

    # Reading the transcript back is the one part of this bridge NOT verified
    # against a live install: the accessor has moved between SDK versions. Try
    # the known shapes, then degrade gracefully.
    #
    # This is safe to degrade: the summary is advisory only. Recursive's loop
    # reads *git* for ground truth on whether anything actually changed, so a
    # missing summary costs readability in the PR body, never correctness.
    summary, turns = extract_summary(conversation)

    emit({"summary": summary, "turns": turns, "ok": True, "error": None})
    return 0


def extract_summary(conversation):
    """Best-effort transcript extraction across SDK versions."""
    texts = []
    turns = 0

    candidates = []
    state = getattr(conversation, "state", None)
    if state is not None:
        for attr in ("events", "history", "messages"):
            value = getattr(state, attr, None)
            if value:
                candidates = list(value)
                break
    if not candidates:
        for attr in ("events", "history", "messages"):
            value = getattr(conversation, attr, None)
            if value:
                candidates = list(value)
                break

    for event in candidates:
        turns += 1
        for attr in ("message", "content", "text", "thought"):
            value = getattr(event, attr, None)
            if isinstance(value, str) and value.strip():
                texts.append(value.strip())
                break

    if not texts:
        return (
            "OpenHands completed the run. Transcript extraction is unavailable for this "
            "SDK version. Inspect `git diff` for what actually changed.",
            turns,
        )

    # The tail carries the agent's closing summary.
    return "\n".join(texts[-6:])[:4000], turns


if __name__ == "__main__":
    sys.exit(main())
