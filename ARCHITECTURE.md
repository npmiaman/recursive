# Recursive. Architecture

**Recursive is installed into a customer's application and makes that application
self-healing.** When something breaks in their production, including the failures
nobody reports and no exception tracker sees. Recursive detects it, contains it in
seconds, and proposes a verified fix.

This document is the design. It is deliberately opinionated about what Recursive
will *not* do, because shipping code into someone else's product is a trust
position before it is a technical one.

---

## 1. The thesis

Existing monitoring answers *"what threw?"*. That misses the failure mode that
costs the most money:

| Failure mode | Throws? | Ticket filed? | Caught by | Typical time-to-detect |
|---|---|---|---|---|
| Server 500s | yes | yes | APM / error tracking | minutes |
| Uncaught JS exception | yes | rarely | error tracking | hours |
| **Button silently stops firing** | **no** | **no** | **nothing** | **weeks, or never** |
| **Form submits into the void** | **no** | **no** | **nothing** | **weeks, or never** |
| **Checkout step users abandon** | **no** | **no** | funnel analytics, eventually | **weeks** |

The bottom three are *silent breakage*. Nothing crashes. Nobody complains, users
just leave. Revenue drops and the graph looks like seasonality.

Recursive's detection edge is that it treats **behavioural friction as a
first-class error signal**, on equal footing with exceptions. A dead click is an
error. A rage click is an error. They just don't have a stack trace.

## 2. What "self-healing" actually means

The instinct is that an AI writes the fix. That is the slowest and riskiest path,
and it is the *second* thing to do, not the first.

```
 latency risk human
Tier 0 contain seconds low none      ← most of the value
Tier 1 repair minutes none reviews PR
Tier 2 ship            ~1 hour medium opt-in only
```

**Tier 0. Contain.** Turn the broken thing off. Kill the feature flag, revert the
deploy, disable the third-party script. No AI involved, no code written, reversible
by construction. This is where most of the value is, and it is the part customers
will trust first.

**Tier 1. Repair.** Reproduce the failure, diagnose it, hill-climb a fix against a
deterministic scorer, open a PR with the evidence attached. Nothing reaches
production without a human. This is the loop already built in `src/loop/inner.ts`.

**Tier 2. Ship.** Auto-merge and canary-deploy low-risk fix classes with automatic
revert on regression. **Off by default. Opt-in per customer, per fix class.**

We build Tier 0 and Tier 1. Tier 2 exists in the design so the interfaces don't have
to change later, but it does not ship until Tier 0/1 have a track record.

## 3. System shape

```
┌── CUSTOMER'S APPLICATION ────────────────────────────────┐
│                                                          │
│   @recursive/sdk                                         │
│     ├─ error capture      (window.onerror, rejections)   │
│     ├─ friction capture   (dead/rage clicks, abandons)   │
│     ├─ health beacons     (did the critical path work?)  │
│     └─ flag runtime       ← the Tier 0 kill mechanism    │
│                                                          │
└──────────────────────┬───────────────────────────────────┘
                       │ telemetry (batched, sampled, scrubbed)
                       ▼
┌── RECURSIVE ─────────────────────────────────────────────┐
│                                                          │
│  DETECT normalize → per-tenant signal store          │
│              + Microsoft Clarity (friction, session-level)│
│              + synthetic journey checks (no traffic req'd)│
│                       │                                   │
│  CORRELATE signals ──┴──▶ Incident                      │
│              (same release? same route? same cohort?)     │
│                       │                                   │
│  DECIDE guardrails: allowlist, blast radius,         │
│ rate limit, kill switch, confidence floor    │
│                       │                                   │
│         ┌─────────────┴─────────────┐                     │
│  TIER 0 │ flag off / rollback       │ seconds, no human  │
│         └─────────────┬─────────────┘                     │
│                       │ still broken, or not containable  │
│         ┌─────────────┴─────────────┐                     │
│  TIER 1 │ reproduce → diagnose →    │  PR for review      │
│         │ hill-climb → verify → PR  │                     │
│         └─────────────┬─────────────┘                     │
│                       │                                   │
│  VERIFY did the real metric recover?                 │
│              → calibration: was the proxy telling truth?  │
└──────────────────────────────────────────────────────────┘
```

Every stage writes to an **append-only audit log**. If Recursive touched a
customer's production, there is an immutable record of what, why, on what evidence,
and under whose authority.

## 4. Trust model

This is the part that matters most. Recursive runs inside other people's products.

### Non-negotiables

1. **Recursive never has write access to customer production by default.** Tier 0
 acts through mechanisms the customer already controls, their flag provider,
 their deploy tool, via credentials they scope and can revoke.
2. **Every autonomous action is reversible.** If it cannot be undone by a single
 inverse operation, it is not a Tier 0 action. No data migrations, no destructive
 commands, no config rewrites.
3. **A kill switch that works without us.** The customer can disable all autonomous
 action from their side, instantly, without contacting support and without
   Recursive's cooperation. A dead-man's-switch design: the SDK stops honoring
 autonomous directives if a local flag is set.
4. **Blast radius is capped before it is calculated.** A Tier 0 action affects at
 most N% of traffic or one flag. Caps are configured by the customer, enforced by
 us, and cannot be raised by the agent.
5. **No customer source code leaves their infrastructure without explicit consent.**
   The Tier 1 fix agent is a library, it runs where they choose. For zero-egress
 customers, the fix stage is pluggable to a self-hosted open scaffold and a local
 model.
6. **Telemetry is scrubbed at the edge, before transmission.** PII redaction happens
 in the SDK, in the customer's process. We should never be in a position to leak
 what we never received.

### Isolation

Tenant → Project → Environment. Signals, incidents, actions, audit records, and
credentials are scoped to a project. There is no cross-tenant read path. A shared
model API is the only shared resource, and prompts never mix tenants.

### The supply-chain problem

Tier 2 means pushing code into a customer's product. That is a supply-chain
position, and it earns supply-chain obligations: signed artifacts, reproducible
builds, staged rollout with automatic halt, per-customer opt-in per fix class, and
a published incident policy for when Recursive itself is the cause. **We do not take
that position until Tier 0 and Tier 1 have a verifiable track record**, which is
precisely what the calibration record in §7 is for.

## 5. Detection

Three independent sources, deliberately overlapping, each catches what the others
miss.

| Source | Catches | Latency | Needs traffic? |
|---|---|---|---|
| **SDK error capture** | exceptions, rejections, failed fetches | seconds | yes |
| **SDK friction capture** | dead clicks, rage clicks, abandonment | seconds | yes |
| **Microsoft Clarity** | same friction, session-level, with replays | ~daily | yes |
| **Synthetic journeys** | anything on the critical path | ~minutes | **no** |

Synthetic checks matter more than they look: they are the only source that works at
3am on a low-traffic tenant, and the only one that detects breakage **before** a real
user hits it.

Clarity's role shifts in this architecture. Its API is rate-limited to 10 calls per
project per day, so it is not a real-time detector, but it is the **evidence and
adjudication layer**: session recordings for reproduction, and an independent
measure of whether a fix actually worked. The SDK detects in seconds; Clarity
confirms in days.

## 6. Correlation, signals to incidents

Raw signals are noisy. An incident is a cluster of signals that share a cause.

Grouped by: **release** (same deploy?), **route** (same page?), **cohort** (same
browser, device, locale, region?), and **time** (started together?).

The single most useful correlation is **release boundary**. If a signal class
appears within minutes of a deploy and was absent before, the cause is almost
certainly that deploy, and the containment is a rollback, with high confidence and
no diagnosis required. This is why Tier 0 can be fast and safe: most production
breakage is *recent change*, and recent change is revertible.

Confidence is explicit and gates action:

| Confidence | Basis | Tier 0 allowed |
|---|---|---|
| high | novel signal, tight release correlation, single flag implicated | yes, automatic |
| medium | correlated but multi-cause, or partial cohort | yes, if flag-scoped |
| low | diffuse, long-standing, or unattributable | no: Tier 1 only |

## 7. Verification and calibration

**An autonomous system that cannot tell whether it helped is not safe to run.**

Every action records what it expected to happen. Verification checks whether it did:

- Tier 0: did the signal rate return to baseline within the window?
- Tier 1: did the real Clarity metric fall, days after the PR merged?

Both feed a **calibration record**, per signal class, how often did the system's
prediction survive contact with reality? A detector that keeps crying wolf loses the
right to trigger Tier 0. A proxy scorer that keeps claiming success while the real
metric is flat gets flagged and stops driving PRs.

This is already implemented for Tier 1 in `src/loop/outer.ts`. It is the mechanism
by which Recursive earns autonomy incrementally rather than being granted it.

## 8. What Recursive deliberately does not do

- **Touch data.** No migrations, no backfills, no record mutation. Ever.
- **Act on infrastructure it doesn't understand.** No scaling, no restarts, no
 config changes outside the declared flag and deploy surfaces.
- **Fix security vulnerabilities autonomously.** Security fixes go to humans. An
 agent that patches auth is an agent that can break auth.
- **Modify tests to make things pass.** A fix that requires changing a test is not
 a fix.
- **Operate without an audit trail.** If it can't be logged, it doesn't run.

## 9. Failure modes we design against

| Risk | Mitigation |
|---|---|
| False positive triggers a needless rollback | Confidence floor + rate limit + calibration-based trust decay |
| Agent "fixes" one metric by breaking another | Composite scorer weighted to the worst regression guard (`src/score/index.ts`) |
| Flapping, heal, re-break, heal | Per-incident action cooldown; repeat incidents escalate to human |
| Recursive itself is the outage | Dead-man's switch; SDK fails open; zero runtime dependency on our availability |
| Telemetry leaks PII | Edge scrubbing in the customer's process before transmission |
| Agent burns the Clarity API budget | Persistent budget ledger with reserved verification quota (`src/clarity/budget.ts`) |

**The SDK must fail open.** If Recursive is down, unreachable, or misbehaving, the
customer's application continues working exactly as if it were never installed.
That property is worth more than any feature in this document.

## 10. Build order

1. ~~Clarity ingestion, diagnosis, proxy scorer, hill-climb, PR, verification~~ ✅
2. **Detection layer**, unified signal model, SDK, ingestion, synthetic checks
3. **Correlation**, signals into incidents with release attribution
4. **Tier 0**, guardrails, flag/deploy providers, decide-and-act, audit log
5. Hardening, the Tier 1 loop end to end against a real repo
6. *(later)* Tier 2, opt-in, once calibration justifies it
