Ticket for 2.0.0-beta.26 (plan item 9). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #685.

## Problem
"Docker and Linux import made-up Hevy workouts" failed on the 2.0.0-beta.25 candidate with "native kept the refused Hevy key in .../integrated-runtime/versions//scenarios/notebook-assistant-browser.mjs". `scenarios/notebook-assistant-browser.mjs` (line 165) holds the made-up key `refused-scenario-key` literally. The native install carries the scenarios folder, so `workouts-from-hevy.sh`'s scan of the install finds that file. `workouts-from-hevy.sh` splits its own copy of the key (`'refused-'"scenario-key"`) for exactly this reason.

## Why
A scenario that fails on another scenario's test file says nothing about Godspeed and teaches everyone to ignore it.

## Why now
It failed the beta.25 candidate.

## Owner decision
Approved here: the browser scenario gets its own made-up key, different from the Hevy scenario's, written so that the literal never appears whole in any file the install carries. Approved changes to what any scenario judges: none. The Hevy scan's roots and its failure stay exactly as they are.

## Outcome
The Hevy scan finds only a key Godspeed itself kept.

## Invariants
- `workouts-from-hevy.sh`'s scan and its FAIL line are unchanged.
- The browser scenario's refused-key transition still tests a refused key.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- No file under `scenarios/` contains `refused-scenario-key` whole, only split literals.
- `bash scenarios/test-scenarios.sh` passes.

## Done means
The change exists and the repository's scenario tests pass.
