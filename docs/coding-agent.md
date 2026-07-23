# Recursive's coding agent

How Recursive writes code, and how that maps onto the way agents like Claude
Code work. This documents the `agentic` fix engine.

## How coding agents like Claude Code work

Strip away the UI and a coding agent is a loop around one idea: give a model
tools, let it call them, feed the results back, repeat until it is done.

```
  system prompt + task
          |
          v
   ┌──────────────┐   the model returns either final text,
   │  ask model   │──> or a batch of tool calls
   └──────┬───────┘
          | tool calls
          v
   ┌──────────────┐   read_file, search, edit_file, write_file,
   │ execute tools│   run_command, ... each has real side effects
   └──────┬───────┘
          | results
          v
   append results to the conversation, loop
          |
          v
   model calls "finish" (or stops calling tools) -> done
```

The pieces that make it more than a for-loop:

1. **Tools as schemas.** Each capability (read a file, grep, edit, run a shell
   command) is declared to the model as a JSON function signature. The model
   chooses which to call and with what arguments.
2. **The context store.** The running `messages` array IS the agent's memory of
   the task: the original instruction, every tool call it made, and every result
   it got back. Because that trail is always in context, the model can grep, read
   three files, edit one, run the tests, see them fail, and edit again, reasoning
   over everything it has already learned.
3. **Real side effects.** Edits hit the disk; `run_command` actually runs. This
   is what lets the agent check its own work instead of guessing.
4. **Context management.** The conversation grows. When it approaches the model's
   window, older bulky content (tool outputs) is summarised or elided so the
   agent can keep going without overflowing.
5. **Safety.** Claude Code gates tools behind permissions. Recursive runs with
   permissions bypassed but inside a git checkpoint the loop can hard-reset, so a
   bad edit costs nothing.

## How Recursive implements each piece

| Claude Code | Recursive | Where |
|---|---|---|
| Tool schemas (Read/Grep/Edit/Write/Bash) | `list_files`, `search`, `read_file`, `edit_file`, `write_file`, `run_command`, `finish` | [src/agents/coding/tools.ts](../src/agents/coding/tools.ts) |
| The agent loop | `runCodingAgent` | [src/agents/coding/agent.ts](../src/agents/coding/agent.ts) |
| Context store | the `messages` array, plus a read/write file set | agent.ts |
| Context compaction | `compact()` elides middle tool outputs, keeps system + task + recent turns | agent.ts |
| Model tool-calling transport | `OpenAICompatibleProvider.toolChat` | [src/llm/provider.ts](../src/llm/provider.ts) |
| Permission bypass inside a checkpoint | per-cycle git checkpoint + hard reset | [src/loop/repair.ts](../src/loop/repair.ts) |
| Read/Edit exact-match semantics | `edit_file` requires the old string to appear exactly once | tools.ts |
| Path sandbox | every tool refuses to touch anything outside the repo root | tools.ts |

### The loop, concretely

`runCodingAgent`:

- seeds `messages` with the system brief and the task (the task is the shared fix
  prompt: the defect, the hypothesis, the retrieved code, memory of past
  attempts);
- calls `provider.toolChat(messages, TOOL_SPECS)`;
- if the model returned tool calls, executes each with `runTool`, appends the
  results, and loops;
- stops when the model calls `finish`, stops calling tools, hits the 40-turn cap,
  or the token budget forces a compaction and it still cannot converge.

It returns the files changed, the turn and tool-call counts, and a transcript.
`git` remains the ground truth for whether anything actually changed, so a model
that claims success while editing nothing is caught downstream.

### Context management

`estimateTokens` (chars/4) paces `compact()`. Compaction keeps the system
message, the task, and the most recent turns verbatim, and replaces older *tool
results* with a placeholder. Tool results (whole files, command output) are the
bulk and the least necessary to keep once acted on; the model's own reasoning and
tool calls stay, so the thread of intent survives.

## The four engines, and why more than one

The coding capability is behind a swappable interface ([Fixer](../src/agents/fixers/types.ts)),
because different users have irreconcilable constraints.

| Engine | Loop | Model | Dependency | Use when |
|---|---|---|---|---|
| `claude-agent-sdk` | agentic | Claude | Anthropic API key | Best quality |
| `agentic` | agentic | any OpenAI-compatible | none | Free/self-hosted, e.g. a NVIDIA coding model |
| `openhands` | agentic | any (self-hostable) | Python SDK + bridge | Hard zero-egress (MIT) |
| `native` | single-shot | any OpenAI-compatible | none | Simplest; localised fixes |

`agentic` is the one that makes "write code, iterate, verify" work for free: the
same loop shape as Claude Code, driven by whatever `LLM_PROVIDER` points at, with
no extra install. Select it with `FIX_ENGINE=agentic`.

### Less restrictive on purpose

The `agentic` engine's brief tells it to fix the problem *properly*: it may
refactor, add helpers, and touch several files, because Recursive ends at a pull
request a human reviews. The only hard rails are the ones that would corrupt the
signal: do not delete or disable the feature to make a check pass, and do not
edit tests or CI to fake success. That is a deliberate departure from the other
engines' "smallest possible diff" instruction.

## Auto-PR mode

By default a verified repair opens a pull request and stops; a human merges.
Auto-PR mode goes one step further and merges it too.

```bash
recursive repair checkout --auto-merge                 # open AND merge
recursive repair checkout --auto-merge --merge-method squash
recursive sweep daily --repair --auto-merge            # for a whole sweep
```

This is the only step that lands a change without a human, so it is opt-in. The
safety that remains is upstream: the repair only reaches the merge after the
closed loop verified it against the real user journey, business postconditions,
and the server, and any branch protection or required checks on the repository
still gate the merge ([mergePullRequest](../src/repo/branch.ts) reports a blocked
merge rather than forcing it).

## Proven end to end

With `FIX_ENGINE=agentic` and DeepSeek V4-Pro on NVIDIA's free endpoint, against a
two-file bug (a discount applied as a flat amount instead of a percentage) with a
failing test:

```
agent: run `node test.mjs`  -> FAIL, expected 225 got 240
agent: search / read to find the cause
agent: edit src/discount.js -> price - price * percent / 100
agent: run `node test.mjs`  -> PASS
agent: finish
```

10 turns, 13 tool calls, verified by the agent running the test itself. See the
demo flow reproduced in the commit that introduced this engine.
