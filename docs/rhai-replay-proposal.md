# Proposal: action traces and deterministic replay in rhai

**Status:** proposal, needs a change inside [rhai](https://github.com/npmiaman/rhai), not Recursive.
**Impact:** roughly 10-30× faster sweeps, near-zero token cost on the common path, and far fewer flakes.

---

## The problem

Every step rhai takes costs a model call. A checkout flow is 20-40 steps, so a
single flow is minutes of wall-clock and a meaningful token bill. That is fine
when a coding agent delegates one task. It is the wrong shape for a sweep, which
runs the same flows over and over, mostly against a product that has not changed.

We are paying an LLM to rediscover "click Add to Cart, then click Checkout, then
fill the card field" every single night.

## The insight

**A flow that succeeded once is a script.** The expensive part, working out what
to click, has already been done. What we want on the next run is to replay that
sequence directly, and only pay for reasoning when the replay stops matching
reality.

That also happens to fix flakiness, because a replayed script is deterministic in
a way an LLM re-deciding each step never is.

## The change

### 1. Emit a trace on success

When a task completes, write the action sequence alongside the result:

```jsonc
{
  "goal": "Add a product to the cart and place the order",
  "startUrl": "https://shop.example.com/",
  "recordedAt": "2026-07-23T10:00:00Z",
  "steps": [
    {
      "action": "click",
      // Several ways to find the element, most stable first. If one breaks,
      // the next is tried before falling back to the model.
      "selectors": [
        "[data-testid='add-to-cart']",
        "role=button[name='Add to cart']",
        "text=Add to cart",
        "css=.product-card:nth-of-type(1) button.btn-primary"
      ],
      // What the agent believed would happen. This is the replay guard:
      // if it doesn't hold, the page has changed and replay must stop.
      "expect": { "urlContains": "/cart", "textPresent": "1 item" }
    },
    { "action": "fill", "selectors": ["[name='card']"], "value": "$CARD_NUMBER" },
    { "action": "click", "selectors": ["role=button[name='Place order']"],
      "expect": { "urlContains": "/order/", "textPresent": "confirmed" } }
  ]
}
```

Two fields carry the weight:

- **`selectors`**, a ranked list, not one string. Test ids survive redesigns;
 role/name survives class renames; CSS is the last resort. Most UI churn breaks
 one and not the others.
- **`expect`**, the postcondition the agent expected. Replay checks it after
 every step. Without it, replay silently drifts into clicking the wrong things.

Values that are secrets or per-run data are stored as `$PLACEHOLDER` and supplied
at replay time, so a trace is safe to commit.

### 2. Replay mode

```bash
rhai-mcp replay <trace.json> [--strict]
```

For each step: resolve the first selector that matches → act → assert `expect`.

- **All steps pass** → done. No model calls at all.
- **Any step fails** → stop replaying and hand control to the normal agent loop
  *from that point*, with the remaining goal as context. It repairs the trace and
 writes the corrected version back.
- **`--strict`** → fail instead of falling back. For CI, where a broken replay
 should be a red build rather than a slow one.

This is the whole idea: **the agent is the fallback, not the default path.**

### 3. Trace storage

rhai already keeps a SQLite memory at `~/.rhai`. Traces belong there, keyed by
goal + origin, with the caveat that a trace recorded against staging should not
be replayed against production without revalidation.

## What this changes

| | Today | With replay |
|---|---|---|
| Typical flow | 20-40 model calls, minutes | 0 model calls, seconds |
| Cost of a 12-flow daily sweep | Significant | Near zero when nothing broke |
| Determinism | Re-decided every run | Fixed sequence, asserted each step |
| A UI change | Rediscovered from scratch | Replay fails at the changed step; agent repairs only that part |

The last row is the underrated one. Today a redesign means a full re-run. With
traces, rhai repairs the trace at the point it broke and continues, which is
also a *precise signal* about what changed, and where.

## Why this belongs in rhai, not Recursive

Recursive can only see rhai's stdout/stderr. It has no visibility into which
element was clicked or why, so it cannot record a trace from the outside. The
action sequence exists only inside rhai's agent loop.

We could reimplement a replay layer in Recursive with Playwright, but then there
are two independent notions of "how to do this flow" that drift apart, and the
self-repair property, which is the best part, would be lost entirely.

## Suggested order

1. **Emit traces** (no behaviour change; pure instrumentation). Ships value on its
 own, a trace is a readable record of what the agent did.
2. **Replay with fallback.** The speed win.
3. **Write repaired traces back.** The self-healing property.

## What Recursive does in the meantime

Already implemented, and independent of this proposal:

- **Tiered models**, `fast` for short flows, escalating to `careful` only on
 failure, so a cheap model can cost latency but never correctness.
- **Step caps per tier**, a confused agent stops instead of wandering.
- **Bounded parallelism**, 3 flows at once by default.
- **Ground-truth verification**, postconditions checked outside the UI, so a
 flow is only green when something other than the page agrees it worked.
- **Quarantine**, a chronically flaky flow stops raising alarms.

These help. Replay is the change that makes running everything, every day,
genuinely cheap.
