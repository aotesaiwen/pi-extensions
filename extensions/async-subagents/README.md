# Async Subagents

Background subagents for pi. The `subagent` tool starts a separate non-interactive `pi` process and returns immediately. When the child finishes, its final assistant message is delivered back to the main session automatically as a new turn.

No tmux, terminal panes, or direct interaction with the child are required.

## Bundled profiles

| Agent | Tools | Use |
|---|---|---|
| `scout` | `read`, `grep`, `find`, `ls` | Read-only codebase recon |
| `researcher` | `web_search` | Web research and sourced summaries |
| `worker` | `read`, `write`, `edit`, `bash` | Isolated implementation work |

Profiles live in `agents/`. Add or override profiles in:

- `~/.pi/agent/agents/*.md` (global)
- `.pi/agents/*.md` (project; highest priority)

## Usage

Ask the main agent to use one:

```text
Use the subagent tool to have scout map the authentication flow, then continue with another task.
```

The tool accepts:

```json
{
  "agent": "scout",
  "name": "auth-map",
  "task": "Map the authentication flow and report exact file paths and line ranges.",
  "cwd": "/optional/working/directory",
  "model": "optional/provider-model",
  "timeoutSeconds": 600
}
```

`name` is only a display label. `agent` selects the profile. The result arrives asynchronously; the main agent should continue working rather than wait or fabricate a result. The launch response includes a stable job ID, timeout, and artifact directory.

### Inspect, cancel, and recover

```text
/subagents                      Show running and recent jobs
/subagents subagent-<uuid>       Inspect one job and its artifact directory
/subagents cancel subagent-<uuid>
/subagents retry subagent-<uuid>  Deliver a saved, undelivered result here
```

The model can use `subagents_status` (optional `id`) for diagnostics and `subagent_cancel` (`id`) to cancel work. `subagents_list` still lists **profiles**, not jobs. Do not poll status: completion remains push-based.

Status includes elapsed time, last activity, tool count, model, usage/cost, errors, and delivery state. Cancellation is idempotent. Cancelling the parent turn after launch does **not** cancel background work; use the cancellation tool/command. A launch whose signal is already aborted is rejected.

## Profile format

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: optional/provider-model
thinking: low
---

System prompt for the subagent.
```

Model precedence is **tool argument → profile → main session**. Omit both model settings to inherit the main session's current model. Omit `tools` to get the safe read-only default (`read`, `grep`, `find`, `ls`).

Non-builtin tools are resolved from pi extensions under `~/.pi/agent/extensions/<tool-name>/index.ts`, with underscores converted to hyphens. For example, `web_search` loads `~/.pi/agent/extensions/web-search/index.ts`.

## Runtime behavior

- Up to **4** subagents run concurrently. `PI_ASYNC_SUBAGENT_MAX` accepts integers from 1–64 (invalid values use 4). Excess launches are rejected; there is no queue.
- Jobs have a **600-second wall-clock timeout**. Override globally with `PI_ASYNC_SUBAGENT_TIMEOUT_SECONDS` or per launch with `timeoutSeconds` (integer 1–86400). Invalid global values use 600.
- Set `PI_ASYNC_SUBAGENT_PI` to use a specific Pi executable or JS entry point.
- The footer shows running jobs and results awaiting delivery.
- Jobs end as `completed`, `failed`, `cancelled`, or `timed_out`. Cancellation and timeout preserve partial output.
- Shutdown/reload cancels running jobs and waits for cleanup without waking the departing session. POSIX children use dedicated process groups: SIGTERM escalates to SIGKILL after 3 seconds. Group cleanup also runs on normal completion, and slots remain occupied until cleanup finishes. Windows uses `taskkill /T` with force escalation. Deliberately detached/escaped processes are not a security boundary and cannot always be reclaimed.
- Each child runs with `--no-session`, `--no-extensions`, and an explicit tool allowlist. Built-in profiles cannot recursively spawn subagents or open interactive dialogs. Explicitly loaded custom extensions remain trusted code.
- Context isolation is **not filesystem isolation**: workers share their working directory unless you provide a separate checkout.

## Output artifacts and delivery

Artifacts are stored under `~/.pi/agent/async-subagents/<session-hash>/<job-id>/` (honoring `PI_CODING_AGENT_DIR`). Set `PI_ASYNC_SUBAGENT_STATE_DIR` to override the root. Copy the **whole extension directory**, including `jobs.ts` and `process.ts`, when installing.

Each job has:

- `job.json`: atomically replaced metadata, task, bounded output preview, usage, errors, and delivery state.
- `output.md`: full final assistant text, or partial text on failure/cancellation.
- `events.jsonl`: child stdout diagnostics, capped at 2 MiB; the last line may be incomplete or a truncation notice.
- `stderr.log`: stderr diagnostics, capped at 2 MiB. The error summary separately retains the last 8,000 characters.

New directories/files use owner-only permissions (0700/0600 on POSIX). Logs may contain source code, task text, or tool output; treat them as private. Diagnostic files are created only when that stream emits data.

Both success and failure text are capped at **120,000 characters** before delivery and link to `output.md`. A single JSON event exceeding 16 Mi characters fails the job rather than allowing unbounded buffering. Artifacts are retained across reloads; they are **not automatically deleted**. Remove old session directories when no longer needed. Memory and the default status view retain 50 recent finished jobs plus active jobs; older jobs remain inspectable by ID and are reconciled lazily.

Delivery is tracked separately from execution:

1. `pending`: saved but not submitted, or a submission failed.
2. `queued`: submitted to Pi, but not yet acknowledged by a custom-message event.
3. `delivered`: Pi emitted the result message. This means receipt, not that the model has acted on it.

`/subagents retry <id>` retries saved results. A queued result can only be retried once Pi is idle, its message queue is empty, and the result is absent from the current branch; this avoids blindly duplicating queued messages. Reload reconciles delivery against the current branch as well. There is no automatic retry loop or exactly-once guarantee across a host crash.

Jobs are bound to their originating session. Automatic delivery is withheld if the originating branch is no longer active; an explicit retry opts into delivery on the current branch. Results already queued in Pi are controlled by Pi's queue. Shutdown and reload preserve undelivered results for inspection, not automatic replay. After an abrupt runtime crash, stale running records become failed with an unknown-child-state warning; the extension does not kill a saved PID that may have been reused.

## Tests

From the `pi-extensions` repository root:

```bash
node --experimental-strip-types --test tests/async-subagents*.test.ts
```

The suite uses fake child processes (no model calls), including timeout/cancellation, SIGTERM-resistant descendants, bounded output, delivery recovery, session isolation, and model precedence.
