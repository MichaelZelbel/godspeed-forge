Ticket for 2.0.0-beta.26 (plan item 3). Size: light. Depends on: nothing (continues pull request #671). Repository: MichaelZelbel/godspeed-mission-control. Issue: #667.

## Problem
When two AI-availability reads overlap and the shared in-flight health check fails, one reader can reuse a cached "ready" value, so a chat briefly presents the AI as usable right after its connection failed.

## Why
The chat then invites the person to type to an AI that just failed.

## Why now
It was found while reviewing #660 (item 2), it reproduces on main, and it belongs with the same promise.

## Outcome
A failed in-flight health check wins over any cached ready value for every reader that overlaps it. Nothing shows "ready" after a failure until a newer check passes.

## Invariants
- A check that passes still shows ready as fast as today.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A concurrency test overlaps two reads with a failing in-flight check and asserts neither reports ready.
- The product's tests and "Integrated Godspeed v2" pass.

## Done means
PR #671's change with its test passing.
