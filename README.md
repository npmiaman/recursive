# clarity-autoresearch

Reads **Microsoft Clarity** to find where real users are hitting friction, then runs
a **[karpathy/autoresearch](https://github.com/karpathy/autoresearch)-style hill-climb**
to fix it — proposing a change, measuring, keeping it if it helped, hard-resetting if
it didn't — and opens a PR. Days later it re-samples Clarity to check whether the real
metric actually moved.

```
Clarity  ──▶  diagnose  ──▶  probe  ──▶  hill-climb  ──▶  PR  ──▶  Clarity again
(what's       (rank by      (a number   (keep or           (ship)   (was it
 broken)       impact)       in secs)    revert)                     actually?)
```

---

## The one design decision that matters

AutoResearch works because the scorer is **fast, deterministic, and cheap**: edit
`train.py`, run 5 minutes, read `val_bpb`, keep or revert, ~12 experiments an hour.

Clarity is the opposite of that. Its numbers update daily at best, require real
traffic through a *deployed* change, are confounded by traffic mix, and the API is
capped at **10 requests per project per day** with a 1–3 day lookback. You cannot
hill-climb against it. One noisy sample per day is not an optimization signal.

So the loop is split in two, at different clock speeds:

| | Inner loop | Outer loop |
|---|---|---|
| **Runs** | seconds, hundreds of times | days, once per shipped fix |
| **Metric** | headless-browser probe score | real Clarity friction rate |
| **Role** | optimization | verification + calibration |
| **Analog** | `val_bpb` | the thing you actually care about |

Clarity picks the fight. The probe drives the optimization. Clarity confirms the win.

The third column is the part that keeps this honest: every verification records
whether the probe *predicted* the real outcome, per issue kind. A probe that keeps
saying "fixed" while Clarity disagrees loses trust and gets flagged — visible in
`npm run cli -- status`.

---

## What the probe actually measures

Each Clarity friction metric gets a mechanical reproduction in a headless browser.
The instrumentation wraps `addEventListener` at document-start, so it can answer the
question `DeadClickCount` implies but can't tell you: *does this element that looks
clickable actually do anything?*

| Clarity metric | Probe |
|---|---|
| `DeadClickCount` | Fraction of interactive-*looking* elements (`cursor:pointer`, button-ish class, `onclick`) with no native semantics and no registered listener |
| `RageClickCount` | Click each control; did **anything** observable happen in 350ms — DOM mutation, network request, navigation? |
| `ScriptErrorCount` | Distinct uncaught errors and unhandled rejections during load and interaction |
| `ErrorClickCount` | Clicks that produce a *new* uncaught error |
| `ExcessiveScroll` | How many viewports down the primary CTA sits, plus page length |
| `QuickbackClick` | FCP, plus whether there's meaningful above-fold content at all |

The composite is:

```
total = 0.7 × primary + 0.3 × (0.4 × mean(guards) + 0.6 × max(guards))
```

That regression term is load-bearing. Without it the agent can "fix" dead clicks by
deleting the element, or fix excessive scroll by deleting content.

It's weighted toward the **worst** guard rather than the average for a reason found
by testing this on the bundled demo page: converting the dead `<div>`s into real
`<button>`s sent `dead-click` 0.80 → 0.00 but `rage-click` 0.00 → 0.80, because the
new buttons still had no handler. Averaged across five guards, that regression moved
the composite by ~0.05 — near-invisible. Trading one defect for another should not
read as a clean win, so the max term makes it cost something.

You can reproduce that yourself:

```bash
node fixtures/serve.mjs &
TARGET_BASE_URL=http://localhost:4173 npm run cli -- score 2
# score 0.6759 — primary dead-click 0.8000
```

---

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

**You do not need a Clarity token to try this.** With `CLARITY_API_TOKEN` empty, the
whole pipeline runs against generated fixtures shaped exactly like the real API
response:

```bash
npm run snapshot     # stores a fixture snapshot
npm run diagnose     # ranks the friction issues in it
```

For live data: Clarity project → **Settings → Data Export → Generate new API token**.
Note that only project admins can do this.

To run the fix loop you also need `TARGET_BASE_URL` (a running instance of the site)
and `TARGET_REPO_PATH` (a clean git checkout of it).

---

## Usage

```bash
npm run cli -- status          # budget, snapshots, shipped fixes, probe calibration
npm run cli -- snapshot        # pull Clarity into the local time series
npm run cli -- diagnose        # ranked list of friction issues
npm run cli -- score 0         # measure issue #0 with the probe, no changes
npm run cli -- fix 0 --dry-run # full hill-climb, commit to a branch, don't push
npm run cli -- fix --top-issue # highest-severity issue, real PR
npm run cli -- verify          # re-sample Clarity, settle up on shipped fixes
```

A typical `fix` run:

```
▶ [78] dead-click on /pricing — 1,240/9,100 sessions (13.6%)
  measuring baseline…
  score 0.4820  (lower is better)
    primary  dead-click        0.6100  8/13 interactive-looking elements have no click affordance.
  investigating root cause…
  hypothesis: The pricing tier cards are <div>s with cursor:pointer and a hover
              state, but selection is handled by an inner radio input that only
              covers ~40px of the card.

  [1/12] Make the whole tier card a real label-wrapped control  (risk: low)
      edited:  2 files changed, 14 insertions(+), 9 deletions(-)
      re-measuring…
      ✓ KEPT   0.4820 → 0.1140  (-0.3680)

  [2/12] Add pressed-state feedback to the tier cards  (risk: low)
      re-measuring…
      ✗ revert 0.1140 → 0.1180  (+0.0040)

  done: 0.4820 → 0.1140 (-0.3680), 1 change(s) kept of 2 tried.
```

Every iteration — including the rejected ones and why — lands in
`data/runs/<issue>.jsonl`.

---

## Steering it: `program.md`

Like autoresearch, **you program the markdown, not the loop.** `program.md` holds
your product context, hard constraints ("never touch pricing numbers"), a map of
where things live, known false positives, and directions worth exploring. It's read
into the investigation and fix prompts on every run.

The "known false positives" section is the highest-leverage part — it's how you stop
the loop burning iterations on non-problems.

---

## Safety

- **The repo must be clean before a run.** The loop reverts by `git reset --hard`
  plus `git clean -fd`; uncommitted work would be destroyed, so it refuses to start.
- **Every attempt is checkpointed.** Failed or errored attempts hard-reset to the
  recorded HEAD before the next iteration begins.
- **Your branch is restored.** Accepted commits are moved onto a `ux/*` branch and
  your working branch is reset to exactly where it started.
- **The API budget is a ledger on disk**, not an in-memory counter — two CLI runs
  can't each think they have a fresh 10. Two calls are reserved so the outer loop
  can always verify.
- **PRs are drafted, not merged.** A human reviews every change.

---

## Known limits

- **The probe can't reproduce everything.** Auth-gated pages, device-specific bugs,
  and locale-specific issues will show a clean baseline despite a real Clarity
  signal. The loop detects this and skips rather than inventing a fix.
- **`ExcessiveScroll` and `QuickbackClick` are the weakest probes** — they're
  proxies for intent, not mechanical failures. Watch their calibration trust score
  before letting them drive PRs.
- **Clarity's API can't attribute friction to a DOM element**, only to a URL. The
  element-level attribution here comes from the probe, not from Clarity — which
  means it's an inference, and occasionally the wrong one.
- **Verification is correlational.** A confirmed drop days after a deploy is
  evidence, not proof; other things shipped too. Treat `confirmed` as "consistent
  with", and use a proper A/B test when the stakes justify it.

---

## Layout

```
program.md              # ← you edit this
src/
  clarity/              # API client, budget ledger, JSONL time series, fixtures
  diagnose/             # friction extraction, severity ranking, trends
  score/                # instrumentation + probes + composite scorer
  agents/               # investigate, research, fix (Agent SDK)
  loop/
    inner.ts            # the AutoResearch hill-climb
    ship.ts             # branch + PR + shipped registry
    outer.ts            # Clarity verification + probe calibration
data/                   # snapshots, budget ledger, run journals, calibration
```
