import type { Issue } from "../../diagnose/issues.ts";
import type { RetrievedContext } from "../../retrieve/index.ts";
import type { FixDirection, Investigation } from "../investigate.ts";

/**
 * The code-editing engine, behind an interface.
 *
 * Recursive edits code in *customers'* repositories, and different customers
 * have irreconcilable constraints:
 *
 *   - Most want the best available quality → Claude Agent SDK.
 *   - Some cannot let source or prompts leave their network at all (BFSI, some
 *     GCCs, regulated public-sector work) → an MIT-licensed engine driving a
 * model they host themselves.
 *
 * Both must produce the same thing: edits in a working tree that the hill-climb
 * then measures and keeps or reverts. Nothing downstream of this interface knows
 * or cares which engine ran, the git checkpoint, the probe, and the keep/revert
 * decision are identical either way.
 */

export interface FixRequest {
  issue: Issue;
  direction: FixDirection;
  investigation: Investigation;
  researchNotes?: string;
  attemptNumber: number;
  previousAttempts: { direction: string; scoreDelta: number }[];
  /** Absolute path to the repository the engine may edit. */
  repoPath: string;
  /**
   * Code retrieved for this failure, if retrieval ran. Optional so an engine
   * can still be driven without it, the agent will just have to search itself,
   * which is slower and lands in the wrong file more often.
   */
  context?: RetrievedContext;
  /**
   * What this project already learned about failures like this one, including
   * approaches already proven not to work. See src/memory.
   */
  memory?: string;
}

export interface FixAttempt {
  /** What the engine reports it changed. */
  summary: string;
  /**
   * Whether the engine believes it edited anything. Advisory only, the loop
   * checks git for the ground truth, because an engine claiming success while
   * changing nothing is a failure mode we've already seen.
   */
  edited: boolean;
  turns: number;
  engine: string;
}

export interface Fixer {
  /** Identifier recorded in the run journal and PR body. */
  readonly name: string;
  /** Human-readable licence/commercial position, surfaced in `cli engines`. */
  readonly licence: string;
  /** True if this engine can run with no egress beyond the customer's network. */
  readonly selfContained: boolean;
  /** Check the engine is actually usable; throw with actionable guidance if not. */
  preflight(): Promise<void>;
  apply(request: FixRequest): Promise<FixAttempt>;
}

/** Which engines exist. Per-project, chosen by the customer. */
export type FixEngine = "claude-agent-sdk" | "openhands" | "native" | "agentic";
