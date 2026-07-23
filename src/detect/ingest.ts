import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeUrl } from "../diagnose/signals.ts";
import { appendSignals } from "./store.ts";
import { fingerprint, type Cohort, type Signal, type SignalClass } from "./types.ts";

/**
 * Telemetry ingestion — the wire format between @recursive/sdk and Recursive.
 *
 * Two rules govern this file:
 *  1. Nothing from a customer's browser is trusted. Every field is validated,
 *     clamped, and truncated before it reaches storage.
 *  2. Scrubbing is defence-in-depth. The SDK redacts PII in the customer's own
 *     process before transmission (ARCHITECTURE.md §4); this is the second pass,
 *     on the assumption that an older SDK version or a custom integration will
 *     eventually send something it shouldn't.
 */

const SIGNAL_CLASSES = [
  "exception",
  "unhandled-rejection",
  "failed-request",
  "dead-click",
  "rage-click",
  "abandon",
  "health-check-failed",
  "slow",
] as const;

const EventSchema = z.object({
  class: z.enum(SIGNAL_CLASSES),
  at: z.string().optional(),
  route: z.string().max(2048),
  message: z.string().max(2000).optional(),
  stack: z.string().max(8000).optional(),
  selector: z.string().max(500).optional(),
  flag: z.string().max(200).optional(),
  count: z.number().int().min(1).max(10_000).optional(),
});

export const PayloadSchema = z.object({
  projectId: z.string().min(1).max(200),
  release: z.string().max(200).optional(),
  sdkVersion: z.string().max(50).optional(),
  session: z
    .object({
      id: z.string().max(200).optional(),
      browser: z.string().max(100).optional(),
      os: z.string().max(100).optional(),
      device: z.enum(["desktop", "mobile", "tablet"]).optional(),
      locale: z.string().max(50).optional(),
      region: z.string().max(100).optional(),
    })
    .optional(),
  // A single batch is capped — an SDK bug or a hostile client should not be able
  // to flood one project's store in a single request.
  events: z.array(EventSchema).max(500),
});

export type Payload = z.infer<typeof PayloadSchema>;

/** Patterns scrubbed from any free-text field before storage. */
const SCRUBBERS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"],
  [/\b(?:\+?\d{1,3}[ -]?)?\(?\d{3,5}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g, "<phone>"],
  [/\b\d{13,19}\b/g, "<card>"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
  [/\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g, "<token>"],
  [/(authorization|api[-_]?key|password|secret|token)["'\s:=]+\S+/gi, "$1=<redacted>"],
];

export function scrub(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

/** Strip query strings — they routinely carry tokens and personal data. */
function scrubRoute(route: string): string {
  return normalizeUrl(route);
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  signals: Signal[];
}

/**
 * Validate, scrub, normalize and persist a telemetry batch.
 * Returns the stored signals so a caller can correlate immediately.
 */
export function ingest(raw: unknown): IngestResult {
  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { accepted: 0, rejected: 1, signals: [] };
  }
  const payload = parsed.data;

  const cohort: Cohort = {
    browser: payload.session?.browser,
    os: payload.session?.os,
    device: payload.session?.device,
    locale: payload.session?.locale,
    region: payload.session?.region,
  };

  const now = new Date().toISOString();

  const signals: Signal[] = payload.events.map((event) => {
    const route = scrubRoute(event.route);
    const message = scrub(event.message) ?? defaultMessage(event.class, event.selector);

    // Client clocks are unreliable and occasionally hostile. Accept a client
    // timestamp only if it is sane; otherwise stamp on arrival.
    let at = now;
    if (event.at) {
      const t = Date.parse(event.at);
      const skew = Math.abs(t - Date.now());
      if (Number.isFinite(t) && skew < 24 * 3600 * 1000) at = new Date(t).toISOString();
    }

    return {
      id: randomUUID(),
      projectId: payload.projectId,
      class: event.class,
      source: "sdk",
      at,
      route,
      release: payload.release,
      cohort,
      fingerprint: fingerprint({
        class: event.class,
        route,
        message,
        selector: event.selector,
      }),
      message,
      stack: scrub(event.stack),
      selector: event.selector,
      flag: event.flag,
      count: event.count ?? 1,
      sessions: 1,
    };
  });

  appendSignals(payload.projectId, signals);
  return { accepted: signals.length, rejected: 0, signals };
}

function defaultMessage(cls: SignalClass, selector?: string): string {
  switch (cls) {
    case "dead-click":
      return `Click on ${selector ?? "element"} produced no response`;
    case "rage-click":
      return `Repeated clicks on ${selector ?? "element"} with no response`;
    case "abandon":
      return "User abandoned the flow";
    case "health-check-failed":
      return "Synthetic health check failed";
    case "slow":
      return "Interaction exceeded latency budget";
    default:
      return cls;
  }
}
