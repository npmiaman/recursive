import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { loadCredentials } from "../auth/store.ts";
import {
  retrievalHitRank,
  type Run,
  type RunEvent,
  type RunKind,
  type RunOutcome,
  type RunTrigger,
  type Stage,
} from "./types.ts";

/**
 * Records what Recursive does, locally first and uploaded after.
 *
 * Local-first is deliberate. A run must never fail because telemetry couldn't be
 * delivered, the fix loop is the product, the recording is instrumentation. So
 * every event lands on disk immediately, and upload is a separate best-effort
 * step that retries stale runs on the next invocation.
 */

function runsDir(): string {
  const dir = resolve(config.dataDir, "runs-pending");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Live streaming is opt-in per run, and only ever a mirror of the on-disk log.
 * On when the run asks for it (RECURSIVE_STREAM=1, which `watch`/`cloud`/`--detach`
 * set) or under CI (a cloud run is watched by definition), and only if logged in.
 */
function liveTarget(): { apiUrl: string; token: string } | undefined {
  const wants = process.env["RECURSIVE_STREAM"] === "1" || !!process.env["CI"];
  if (!wants) return undefined;
  const credentials = loadCredentials();
  if (!credentials) return undefined;
  return { apiUrl: credentials.apiUrl, token: credentials.token };
}

export class Recorder {
  private run: Run;
  private events: RunEvent[] = [];
  private seq = 0;
  private stageStarted = new Map<Stage, number>();
  private path: string;
  private live?: { apiUrl: string; token: string };
  private pending: RunEvent[] = [];
  private pumpPromise?: Promise<void>;

  constructor(input: {
    kind: RunKind;
    projectId: string;
    trigger?: RunTrigger;
    subject?: Run["subject"];
    repo?: Run["repo"];
  }) {
    const credentials = loadCredentials();
    this.live = liveTarget();
    this.run = {
      id: randomUUID(),
      accountId: credentials?.accountId ?? "local",
      projectId: input.projectId,
      kind: input.kind,
      trigger: input.trigger ?? "manual",
      status: "running",
      startedAt: new Date().toISOString(),
      repo: input.repo,
      subject: input.subject,
      outcome: {},
      environment: {
        provider: config.llmProvider,
        model: config.llmProvider === "openai" ? config.openAiModel : config.model,
        fixEngine: config.fixEngine,
        recursiveVersion: "0.1.0",
      },
    };
    this.path = resolve(runsDir(), `${this.run.id}.jsonl`);
    this.write({ type: "run", run: this.run });
  }

  get id(): string {
    return this.run.id;
  }

  private write(record: unknown): void {
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n");
    } catch {
      // Instrumentation must never break the thing it instruments.
    }
  }

  /** Record an event. Returns immediately; nothing here blocks the loop. */
  event(stage: Stage, type: string, message: string, data?: Record<string, unknown>): void {
    const started = this.stageStarted.get(stage);
    const event: RunEvent = {
      runId: this.run.id,
      seq: this.seq++,
      at: new Date().toISOString(),
      stage,
      type,
      message,
      ...(started ? { durationMs: Date.now() - started } : {}),
      ...(data ? { data } : {}),
    };
    this.events.push(event);
    this.write({ type: "event", event });
    if (this.live) {
      this.pending.push(event);
      this.wake();
    }
  }

  /**
   * Ensure a single pump loop is running. Concurrent callers share the one
   * in-flight promise rather than starting a second, racing loop.
   */
  private wake(): void {
    if (!this.live || this.pumpPromise) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = undefined;
    });
  }

  /**
   * Drain buffered events to the dashboard so `watch` sees them in near real
   * time. Best-effort: a failed push drops the batch from the LIVE view only —
   * every event is still on disk and `flushRuns` delivers the complete run at
   * the end, so the authoritative record is never lossy.
   */
  private async pump(): Promise<void> {
    while (this.live && this.pending.length) {
      const batch = this.pending.splice(0, this.pending.length);
      try {
        await fetch(`${this.live.apiUrl}/api/runs/${this.run.id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.live.token}`,
          },
          body: JSON.stringify({ run: this.run, events: batch }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        // Network blip: the on-disk log + flushRuns remain the source of truth.
      }
    }
  }

  /**
   * Await delivery of everything buffered so far. Loops because an event can
   * arrive after the pump's last drain but before it settles; keep pumping until
   * nothing is pending and no push is in flight. Callers use this before exit.
   */
  async drainLive(): Promise<void> {
    while (this.live && (this.pending.length || this.pumpPromise)) {
      this.wake();
      await this.pumpPromise;
    }
  }

  /** Mark the start of a stage so subsequent events carry a duration. */
  beginStage(stage: Stage, message: string): void {
    this.stageStarted.set(stage, Date.now());
    this.event(stage, `${stage}.start`, message);
  }

  merge(outcome: Partial<RunOutcome>): void {
    Object.assign(this.run.outcome, outcome);
  }

  /**
   * Close the run.
   *
   * Computes the retrieval hit rank here rather than at query time: the answer
   * depends on what the agent edited, which is only known now, and recording it
   * once beats recomputing it across every future analytics query.
   */
  finish(status: Run["status"], outcome: Partial<RunOutcome> = {}): Run {
    Object.assign(this.run.outcome, outcome);

    const { retrievedFiles, editedFiles } = this.run.outcome;
    if (retrievedFiles?.length && editedFiles?.length) {
      this.run.outcome.retrievalHitRank = retrievalHitRank(retrievedFiles, editedFiles);
    }

    this.run.status = status;
    this.run.endedAt = new Date().toISOString();
    this.run.durationMs = Date.parse(this.run.endedAt) - Date.parse(this.run.startedAt);

    this.event("end", `run.${status}`, `Run ${status}`);
    this.write({ type: "run", run: this.run });
    return this.run;
  }

  snapshot(): Run {
    return { ...this.run };
  }
}

// ------------------------------------------------------------ upload

interface PendingRun {
  run: Run;
  events: RunEvent[];
}

function readPending(path: string): PendingRun | undefined {
  try {
    let run: Run | undefined;
    const events: RunEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { type: string; run?: Run; event?: RunEvent };
      // Later `run` records supersede earlier ones, the last is the final state.
      if (record.type === "run" && record.run) run = record.run;
      else if (record.type === "event" && record.event) events.push(record.event);
    }
    return run ? { run, events } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Upload finished runs, oldest first.
 *
 * Best-effort by design: called opportunistically, never blocking. A run that
 * fails to upload stays on disk and is retried next time, so a laptop that was
 * offline during a run still reports it later.
 */
export async function flushRuns(options: { limit?: number } = {}): Promise<{
  uploaded: number;
  pending: number;
  skipped: string | undefined;
}> {
  const credentials = loadCredentials();
  if (!credentials) {
    const pending = readdirSync(runsDir()).filter((f) => f.endsWith(".jsonl")).length;
    return { uploaded: 0, pending, skipped: "not logged in, run `recursive login`" };
  }

  const files = readdirSync(runsDir())
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .slice(0, options.limit ?? 20);

  let uploaded = 0;

  for (const file of files) {
    const path = resolve(runsDir(), file);
    const pending = readPending(path);
    // Still running, leave it for a later flush.
    if (!pending || pending.run.status === "running") continue;

    try {
      const response = await fetch(`${credentials.apiUrl}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.token}`,
        },
        body: JSON.stringify({ run: pending.run, events: pending.events }),
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        unlinkSync(path);
        uploaded++;
      } else if (response.status === 401) {
        return {
          uploaded,
          pending: files.length - uploaded,
          skipped: "credentials rejected, run `recursive login` again",
        };
      }
      // Other errors: leave the file for the next attempt.
    } catch {
      break; // network down; stop trying this round
    }
  }

  const remaining = readdirSync(runsDir()).filter((f) => f.endsWith(".jsonl")).length;
  return { uploaded, pending: remaining, skipped: undefined };
}

export function pendingRunCount(): number {
  if (!existsSync(runsDir())) return 0;
  return readdirSync(runsDir()).filter((f) => f.endsWith(".jsonl")).length;
}
