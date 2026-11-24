Status: done (merge 9ec2008f7aeca7dc66d4c3e02e897abf7f5704bd)

Ticket for 2.0.0-beta.26 (plan item 10). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #680.

## Problem
The test "a Hermes routine that prints a step question makes it answerable only after Hermes delivered the words" in `notebook/test/waiting-steps.test.mjs` failed once in the fresh-server test (run 43819121019) on code that passed elsewhere. `deliveryClock` in `notebook/core/waiting-steps.mjs` stamps a delivery at `max(now, last + 1 ms)`. When the delivery and the following `heard(...)` fall in the same millisecond, the delivery can be stamped later than the answer, so the "yes" does not count.

## Why
Since product PR #678 this test gates every pull request, so a same-millisecond flake costs a rerun on any change.

## Why now
It appeared the day the integrated tests started gating pull requests.

## Outcome
The test passes deterministically, and the product never ignores an answer because of millisecond timing.

## Invariants
- What the test asserts stays: a question is answerable only after its words were delivered.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The pull request confirms the cause: a test that forces the same millisecond reproduces the failure before the fix.
- The fix is a deterministic clock in the test, or `heard` ordering by recorded position, whichever matches the cause.
- The product's tests pass, including 200 repeated runs of this test file.

## Done means
The change and its reproduction exist and pass with the repository's tests.
