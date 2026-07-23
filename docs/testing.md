# Testing Recursive against a real codebase

How to point Recursive at a different application, on localhost, and verify that
every capability actually works, backend included.

## The fastest answer: `recursive doctor`

Before any sweep, run the self-check. It exercises the real code path of every
subsystem and reports pass / warn / fail with a concrete detail.

```bash
npm run cli -- doctor --repo /path/to/the/app --project myapp
```

```
  ✓ reasoning model   openai-compatible (NVIDIA) - deepseek-ai/deepseek-v4-flash
  ✓ fix engine        agentic ready
  ✓ headless browser  Chromium launches
  ✓ git repository    clean at main
  ✓ flow manifest     3 flow(s), 2 critical
  ✓ base memory       412 file(s), 412 with model summaries
  ✓ retrieval         412 file(s) - 3181 chunk(s)
  ✓ memory store      append and recall work
  ✓ backend trace     reachable (200)
```

Everything green means Recursive can do its whole job on this app. A `fail` names
exactly what is missing. Warnings are usually "you have not set X up yet".

## What the target app needs

Recursive works on any web app, but three things unlock the full pipeline:

### 1. A flow manifest (required for sweeps and repair)

`recursive.flows.json` at the app's repo root describes the user journeys to
exercise. Generate a starter and edit it:

```bash
npm run cli -- sweep init --repo /path/to/the/app
```

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "flows": [
    {
      "id": "checkout",
      "name": "Customer can complete a purchase",
      "critical": true,
      "url": "/",
      "goal": "Add a product to the cart, go to checkout, pay with the test card, place the order.",
      "expect": "An order confirmation with an order number appears.",
      "touches": ["checkout", "cart", "orders"],
      "verify": [
        {
          "name": "an order was really created",
          "kind": "count-delta",
          "url": "http://localhost:3000/api/test/orders/count",
          "countPath": "count",
          "expectDelta": 1
        }
      ]
    }
  ]
}
```

The `verify` block is what makes "did the backend actually work" answerable. It
is checked from OUTSIDE the UI: the screen saying "Order confirmed" is not
evidence; the order count going up by one is. Kinds:

- `count-delta` - a counter (order count, row count) moved by an exact amount.
- `http` - an endpoint returns an expected status / body.
- `absence` - something that must NOT exist afterwards is absent.

For this you expose a couple of tiny read-only test endpoints in the app (only in
non-production), e.g. `GET /api/test/orders/count` returning `{ "count": N }`.

### 2. A backend trace endpoint (optional, deepens backend checks)

Postconditions catch "the state did not change." A trace endpoint additionally
catches "the server errored or behaved abnormally while the UI looked fine."
Add `backendTraceUrl` (and `backendTokenEnv` for auth) to the manifest, pointing
at an endpoint that returns the server calls made in a time window:

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "backendTraceUrl": "http://localhost:3000/api/test/trace",
  "backendTokenEnv": "TRACE_TOKEN",
  "flows": [ /* ... */ ]
}
```

The endpoint returns recent requests with status codes and any unhandled errors.
Recursive checks invariants (no 5xx, no unhandled exception) and, once it has seen
a few clean runs, learns the flow's normal call shape and flags deviations. The
server SDK in `packages/server-sdk` provides this if you would rather not write
it by hand.

### 3. A model provider (for enrichment, diagnosis, and code-writing)

Anything OpenAI-compatible. The free option is a NVIDIA model:

```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
OPENAI_MODEL=deepseek-ai/deepseek-v4-flash
OPENAI_API_KEY=nvapi-...
OPENAI_RPM=40
FIX_ENGINE=agentic
```

## The full test, end to end

```bash
# 0. Point Recursive at the app, get the app running on localhost separately.
cd /path/to/the/app && npm run dev   # in its own terminal

# 1. Learn the codebase.
npm run cli -- memory index --repo /path/to/the/app --project myapp

# 2. Confirm every subsystem works.
npm run cli -- doctor --repo /path/to/the/app --project myapp

# 3. Run the browsing agent over the flows. Reports what is broken, backend included.
npm run cli -- sweep daily --repo /path/to/the/app --project myapp

# 4. Watch it happen in a real browser (optional).
npm run cli -- sweep daily --repo /path/to/the/app --watch

# 5. Fix what breaks: change code, re-verify the journey AND the backend, open a PR.
npm run cli -- sweep daily --repo /path/to/the/app --project myapp --repair

# 6. Or repair one known-broken flow directly.
npm run cli -- repair checkout --repo /path/to/the/app --project myapp
```

To let Recursive merge its own verified PRs, add `--auto-merge` (see
[coding-agent.md](coding-agent.md#auto-pr-mode)).

## Verifying each capability in isolation

| Capability | Command | What proves it works |
|---|---|---|
| Base memory | `memory index` then `memory` | file + summary counts go up |
| Retrieval | `retrieve --message "the buy button does nothing"` | the checkout file ranks at the top |
| Detection | `ingest signals.json` then `incidents` | a signal batch becomes a correlated incident |
| Cohort analysis | `cohorts --dimension Device` | a hard-hit group is found; a uniformly-bad page is not |
| Tier 0 containment | `heal --dry-run` | guardrails allow / block, with reasons |
| Sweep | `sweep daily` | the broken flow is reported, the working ones pass |
| Backend verification | `sweep daily` on an app with a lying UI | flagged even though the screen looked correct |
| Repair | `repair FLOW_ID` | code changes, the journey re-verifies, a PR opens |
| Memory | `memory search "..."` | a past failure and its attempts come back |

## Testing without any target app

The whole detect-to-contain pipeline runs against built-in fixtures, no app and
no keys required:

```bash
npm run cli -- demo
npm test                # 48 checks across scrub, retrieve, memory, cohort, ratelimit
npm run test:loop       # the closed repair loop, real browser
npm run eval:retrieve . demo-shop   # retrieval benchmark
```

## Notes on pulling a repo to test locally

A repo tests cleanly when it: runs on localhost with a single command, needs no
external secrets or live third-party services to complete the core flow (use a
test/stub mode), and can expose the small read-only test endpoints above. Apps
that require a real payment processor, a seeded production database, or SSO to
complete their main journey need those stubbed first, which is a property of the
app, not of Recursive.
