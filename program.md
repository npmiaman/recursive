# program.md

**This file is the steering wheel.** In Karpathy's `autoresearch`, you don't write
the Python, you write `program.md`, and the agent reads it to decide what to try.
Same idea here: this file tells the fix loop what "better" means for *your*
product, what it may and may not touch, and where to look first.

Edit this. It is read by the investigation and fix stages on every run.

---

## What this product is

<!-- Replace with a few lines about your site. The agent uses this to judge
 whether a proposed change is appropriate. -->

A B2B SaaS marketing site and self-serve signup flow. Visitors arrive from search
and paid ads, read about the product, compare pricing, and start a trial. The
money path is `/` → `/pricing` → `/signup` → `/checkout`.

## What "better" means here

In priority order:

1. **Nothing on the money path is ever broken.** A dead control or script error on
   `/pricing`, `/signup`, or `/checkout` outranks everything else regardless of
 traffic.
2. **Interactive things must look interactive, and interactive-looking things must
 work.** This is the single most common defect class and the cheapest to fix
 correctly.
3. **The primary action should be reachable without hunting.** If users scroll
 past two viewports to find the CTA, the page is failing them.
4. **Fast enough that nobody bounces before it renders.**

## Constraints, do not violate these

- **Never change pricing numbers, plan names, legal copy, or anything in
  `/legal/**`.** Escalate instead.
- **Never modify tests to make something pass.** If a fix breaks a test, the fix
 is wrong.
- **No new dependencies** without saying so explicitly in the PR body.
- **No redesigns.** The smallest change that fixes the measured defect. If the
 right fix is a redesign, say so and stop, that is a human decision.
- **Match existing conventions.** Same component patterns, same styling approach,
 same naming as the surrounding code.

## Where things live

<!-- Fill this in. It saves the fix agent several minutes of grepping per run
 and dramatically improves its hit rate. -->

- Page components: `src/routes/**`
- Shared UI: `src/components/**`
- Design tokens / theme: `src/styles/tokens.css`
- Analytics + Clarity init: `src/lib/analytics.ts`

## Known false positives

<!-- Add to this list as you learn. Anything here should be skipped rather than
     "fixed", this is how you stop the loop wasting iterations on non-problems. -->

- The cookie banner registers no click listener until consent JS loads, so it can
 read as a dead click on a cold cache. Not a real defect.
- `/docs/**` pages are intentionally long; excessive-scroll signals there are
 expected and should be ignored.

## Directions worth exploring

<!-- This is the part most like autoresearch's research directions. Anything you
 list here becomes a candidate the loop can try. -->

- Convert card-style `<div>`s with `cursor: pointer` into real `<button>` or `<a>`
 elements rather than attaching click handlers to them.
- Where a control triggers async work, ensure there is immediate visual feedback
  (pressed state, spinner), silent latency is the most common rage-click cause.
- On `/pricing`, test whether moving the primary CTA above the comparison table
 reduces the scroll-depth signal.
- Audit third-party script error boundaries; several script errors trace to
 analytics/chat widgets rather than our own code.

---

## How the loop uses this

1. **Clarity** picks the target, which page and which friction metric is costing
 the most real sessions.
2. **The probe** turns that into a number that moves in seconds.
3. **The agent** proposes a change from the directions above, applies it, and the
 probe re-measures.
4. **Better → committed. Not better → hard reset.** No debate, no partial credit.
5. **Clarity again**, days later, confirms whether the real metric actually fell, and records whether the probe told the truth.
