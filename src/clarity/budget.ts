import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";

/**
 * Clarity allows a maximum of 10 API requests per project per day.
 * Exceeding it returns 429 and you are blind until the window resets.
 *
 * That budget is the hard constraint the whole system is designed around, so it
 * is enforced by a ledger on disk rather than an in-memory counter, otherwise
 * two CLI invocations (or a crashed loop that restarts) would each think they
 * had a fresh 10.
 *
 * The API reports in UTC, so the ledger buckets by UTC date.
 */

export const DAILY_LIMIT = 10;

/** Calls we refuse to spend on anything but an explicit user-driven pull. */
const RESERVE_FOR_VERIFICATION = 2;

interface Ledger {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  spent: number;
  calls: { at: string; label: string }[];
}

function ledgerPath(): string {
  return resolve(config.dataDir, "clarity-budget.json");
}

function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function read(): Ledger {
  const path = ledgerPath();
  const today = utcDate();
  if (!existsSync(path)) return { date: today, spent: 0, calls: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Ledger;
    // A stale ledger from a previous UTC day means the window reset.
    if (parsed.date !== today) return { date: today, spent: 0, calls: [] };
    return parsed;
  } catch {
    // A corrupt ledger must not hand out a fresh budget, assume the worst and
    // treat the day as fully spent until a human clears the file.
    console.warn("[budget] ledger unreadable; treating today as exhausted.");
    return { date: today, spent: DAILY_LIMIT, calls: [] };
  }
}

function write(ledger: Ledger): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2));
}

export interface BudgetState {
  spent: number;
  remaining: number;
  limit: number;
  date: string;
}

export function state(): BudgetState {
  const ledger = read();
  return {
    spent: ledger.spent,
    remaining: Math.max(0, DAILY_LIMIT - ledger.spent),
    limit: DAILY_LIMIT,
    date: ledger.date,
  };
}

export class BudgetExhaustedError extends Error {
  constructor(remaining: number, needed: number) {
    super(
      `Clarity daily budget exhausted: ${remaining} call(s) left, ${needed} needed. ` +
        `The limit is ${DAILY_LIMIT}/project/day and resets at 00:00 UTC. ` +
        `Run against the cached snapshots in data/snapshots.jsonl instead.`,
    );
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Reserve budget before making a call. Throws rather than letting the caller
 * discover exhaustion via a 429 (which still counts against nothing, but leaves
 * the loop in an ambiguous state).
 *
 * `priority: "reserved"` may dip into the verification reserve; everything else
 * stops short of it so the outer loop can always confirm a shipped fix.
 */
export function spend(label: string, count = 1, priority: "normal" | "reserved" = "normal"): void {
  const ledger = read();
  const floor = priority === "reserved" ? 0 : RESERVE_FOR_VERIFICATION;
  const usable = Math.max(0, DAILY_LIMIT - floor - ledger.spent);

  if (usable < count) {
    throw new BudgetExhaustedError(usable, count);
  }

  ledger.spent += count;
  ledger.calls.push({ at: new Date().toISOString(), label });
  write(ledger);
}

/** Test/ops escape hatch: clear today's ledger. */
export function reset(): void {
  write({ date: utcDate(), spent: 0, calls: [] });
}
