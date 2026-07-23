import { config } from "../../config.ts";
import { ClaudeAgentFixer } from "./claude.ts";
import { OpenHandsFixer } from "./openhands.ts";
import { NativeProviderFixer } from "./native.ts";
import { AgenticFixer } from "./agentic.ts";
import type { FixEngine, Fixer } from "./types.ts";

export type { FixAttempt, FixEngine, Fixer, FixRequest } from "./types.ts";
export { ClaudeAgentFixer } from "./claude.ts";
export { OpenHandsFixer } from "./openhands.ts";
export { NativeProviderFixer } from "./native.ts";
export { AgenticFixer } from "./agentic.ts";

/**
 * Engine selection.
 *
 * Per-project rather than global, because the constraint that drives it is the
 * customer's, not ours: a bank that cannot let prompts leave its network and a
 * startup that wants the best available fix quality are both right, and both are
 * customers.
 */
export function resolveFixer(engine?: FixEngine): Fixer {
  const selected = engine ?? config.fixEngine;

  switch (selected) {
    case "openhands":
      return new OpenHandsFixer({
        model: config.openHandsModel,
        baseUrl: config.openHandsBaseUrl,
        apiKeyEnv: "LLM_API_KEY",
      });
    case "native":
      return new NativeProviderFixer();
    case "agentic":
      return new AgenticFixer();
    case "claude-agent-sdk":
      return new ClaudeAgentFixer();
    default: {
      // Exhaustiveness guard: a new engine added to the union without a case
      // here becomes a compile error rather than a silent fallback to Claude.
      const unreachable: never = selected;
      throw new Error(`Unknown fix engine '${String(unreachable)}'.`);
    }
  }
}

/** For `cli engines`, what's available and what each one commits you to. */
export function describeEngines(): {
  name: string;
  licence: string;
  selfContained: boolean;
  active: boolean;
}[] {
  return [
    new ClaudeAgentFixer(),
    new OpenHandsFixer({ model: config.openHandsModel }),
    new NativeProviderFixer(),
    new AgenticFixer(),
  ].map(
    (fixer) => ({
      name: fixer.name,
      licence: fixer.licence,
      selfContained: fixer.selfContained,
      active: fixer.name === config.fixEngine,
    }),
  );
}
