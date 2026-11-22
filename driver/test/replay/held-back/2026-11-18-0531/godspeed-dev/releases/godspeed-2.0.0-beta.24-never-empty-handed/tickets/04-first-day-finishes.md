Status: done (merge cd18d8377a09f3e635c8f00aebf14bcdb018d35e)

Ticket for 2.0.0-beta.24 (plan item 4). Size: full. Depends on: nothing.

## Problem
Scenario `first-day` ("a fresh Docker server turns a first goal into useful work and a matching Telegram brief") failed in the nightly run of 2026-11-13 on main (690266d). The installed routine "Daily round: choose today's work" finished in 95 s. Then "Daily round: do the work" did not finish successfully within 1800 s. The cause is not known yet. The same scenario passed on the 2.0.0-beta.23 candidate run the night before.

## Why
The first day is what a new user judges Godspeed by, and a work routine that hangs gives them nothing.

## Why now
It failed on the public code last night.

## Outcome
Find the cause from the run's logs (https://github.com/MichaelZelbel/godspeed-mission-control/actions/runs/43404437023, the job of that name) and from the routine's code.
- If Godspeed hangs, waits on something that never comes, or retries without end: fix it so "do the work" either finishes or stops with a plain reason within its time.
- If the cause is only the scenario (its time limit, its AI): fix the scenario, and say so in the pull request.

## Invariants
- The work routine's results on a successful day are unchanged.
- No outward action (a message, a post, a purchase) is added.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The pull request names the cause, with the log lines that show it.
- A unit test reproduces the hang or endless wait and passes after the fix. For a cause that lies only in the scenario, the pull request shows the scenario change and why.

## Done means
The cause is written in the pull request, and the test above passes with the repository's tests.
