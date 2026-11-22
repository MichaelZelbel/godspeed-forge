Ticket for 2.0.0-beta.26 (plan item 6). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #615.

## Problem
The notebook UI's dependencies carry 26 known vulnerability records. #617 removed them by upgrading react-router from 6 to 7 and zod from 3 to 4. After a server restart, the signed-in Import page then sometimes rendered an empty document (3 of 5 runs), so #654 reverted the change and the records came back.

## Why
People run the notebook on servers reachable from the internet, and known vulnerabilities in what it serves should be fixed.

## Why now
The revert was a stopgap. Since product PR #678, the integrated check (install, restart, signed-in pages) runs on every pull request, so a fix can be proven before it merges.

## Outcome
No vulnerability record of high or critical severity remains in the notebook UI's dependencies, and a restart still opens every signed-in page.

## Invariants
- First try fixed versions within the current majors, or remove packages nothing uses. React-router 7 or zod 4 only if "Integrated Godspeed v2", restart included, passes on the branch.
- No test or check is loosened; the restart check keeps its assertions.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- `npm audit` in `notebook/ui` (or the repository's own audit step) shows no high or critical record, and the pull request lists what changed per package.
- "Integrated Godspeed v2" passes on the exact head, restart included.
- The product's tests pass.

## Done means
The dependency change exists, the audit has no high or critical record, and the repository's tests pass.
