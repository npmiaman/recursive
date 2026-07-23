import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeUrl } from "../diagnose/signals.ts";
import { appendSignals } from "./store.ts";
import { fingerprint, type Cohort, type Signal, type SignalClass } from "./types.ts";

/**
 * Telemetry ingestion, the wire format between @recursive/sdk and Recursive.
 *
 * Two rules govern this file:
 *  1. Nothing from a customer's browser is trusted. Every field is validated,
 * clamped, and truncated before it reaches storage.
 *  2. Scrubbing is defence-in-depth. The SDK redacts PII in the customer's own
 * process before transmission (ARCHITECTURE.md §4); this is the second pass,
 * on the assumption that an older SDK version or a custom integration will
 * eventually send something it shouldn't.
 */

const SIGNAL_CLASSES = [
  "exception",
  "unhandled-rejection",
  "failed-request",
  "server-error",
  "api-error",
  "timeout",
  "crash",
  "dead-click",
  "rage-click",
  "abandon",
  "data-error",
  "assertion-failed",
  "test-failure",
  "build-failure",
  "performance-regression",
  "slow",
  "health-check-failed",
  "flow-failure",
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
  // A single batch is capped, an SDK bug or a hostile client should not be able
  // to flood one project's store in a single request.
  events: z.array(EventSchema).max(500),
});

export type Payload = z.infer<typeof PayloadSchema>;

/**
 * Patterns scrubbed from any free-text field before storage.
 *
 * ORDER IS LOAD-BEARING and the list is applied top to bottom. Specific patterns
 * must run before greedy ones, or the greedy one wins and mislabels, or worse,
 * partially matches and leaves the secret behind. Both happened:
 *
 *   - The phone pattern used to run before the card pattern, so a 16-digit card
 * number was stored as "<phone>".
 *   - `authorization: Bearer sk_live_xxx` matched only as far as "Bearer",
 * producing "authorization=<redacted> sk_live_xxx", the token survived,
 * in a field we then persisted. That is the exact failure this file exists
 * to prevent.
 *
 * Any change here needs a test against a payload carrying each secret type.
 */
const SCRUBBERS: [RegExp, string][] = [
  // Structured credentials first, most specific, least ambiguous.
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
  // Provider key formats. Allows internal separators (sk_live_…, ghp-…), which
  // the previous [A-Za-z0-9]{16,} class rejected, that is why sk_live_ leaked.
  [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, "<token>"],
  // Auth schemes: consume the whole credential, not just the scheme word.
  [/\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "<auth>"],
  // key=value / key: value, the value class excludes only true delimiters, so
  // it consumes the entire secret rather than stopping at the first separator.
  [
    /\b(authorization|api[-_]?key|apikey|password|passwd|pwd|secret|token|credential|session[-_]?id)\b\s*["']?\s*[:=]\s*["']?[^\s"',;)}\]]{4,}/gi,
    "$1=<redacted>",
  ],
  // Card before phone: a 16-digit PAN also satisfies the phone shape.
  [/\b\d{13,19}\b/g, "<card>"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"],
  // Greediest last. Three groups of 3-5 digits covers +91 98765 43210 (the
  // original pattern's fixed 3-4 digit tail did not, which matters when the
  // primary market is India), US 555-123-4567, and most international formats.
  // Deliberately errs toward over-matching: a scrubbed build number is a
  // cosmetic loss, a stored phone number is a compliance incident.
  [/\b\+?\d{1,3}[\s-]?\d{3,5}[\s-]?\d{3,5}\b/g, "<phone>"],
];

export function scrub(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

/** Strip query strings, they routinely carry tokens and personal data. */
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
