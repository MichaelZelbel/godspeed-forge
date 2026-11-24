Ticket for 2.0.0-beta.26 (plan item 5). Size: light. Depends on: the revert of #617 being on main. Repository: MichaelZelbel/godspeed-mission-control.

## Problem
Pull request #617 removed 26 vulnerability records (3 critical, 5 high, 18 moderate) from the notebook UI's dependencies, partly by moving react-router-dom from 6 to 7 and zod from 3 to 4. After it merged, main's integrated image check failed: after a restart, the signed-in Import page renders an empty document (#619; the nightly stage then refused the older image, #622). Main was green at 9922403 and red at 5fecb8d, with #617 the only change, so #617 was reverted. The vulnerability records are back.

The integrated image check (`.github/workflows/v2-integrated.yml`) runs only after a push to main, so a pull request can merge without it; that is how #617 got in.

## Why
Shipped browser features use some of the affected packages; and a restart that loses a page breaks every server install.

## Why now
The revert brought the records back; the removal should not wait a whole round.

## Owner decision
Decided 2026-11-15 by Mission Control as a question of how: major-version upgrades are allowed only when `Integrated Godspeed v2`, started on the pull request's branch with workflow_dispatch, passes on its exact head, restart included. Otherwise fixed versions within the current major versions, or removing packages the UI does not use, are enough.

## Outcome
No vulnerability record of high or critical severity remains in `notebook/ui`'s lockfile, moderate ones only where no fixed version exists within reach (each named in the pull request), and a server install still shows every signed-in page after a restart.

## Invariants
- The shared-note sanitizer keeps blocking executable and overlay content (the regression tests #617 added stay).
- No route, page title or sign-in behaviour changes.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- `npm audit` in `notebook/ui` shows no high or critical record; the remaining moderate ones are listed with the reason.
- The notebook web page's unit tests and type check pass.
- A run of `Integrated Godspeed v2` on the exact head passes, linked in the pull request; if the builder's token cannot start it, the pull request says so and Mission Control starts it.

## Done means
The dependency change and its tests exist and pass with the repository's tests.
