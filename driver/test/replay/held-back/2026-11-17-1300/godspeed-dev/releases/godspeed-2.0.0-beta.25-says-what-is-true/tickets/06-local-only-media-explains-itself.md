Status: done (merge e2eebde43b1b6d880cc2b140c48ff63f20408978)

Ticket for 2.0.0-beta.25 (plan item 6). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control.

## Problem
A picture or PDF the notebook accepts but which is too large to travel with the private GitHub copy (over the 50 MB travelling limit, under the 100 MB upload limit) stays on the computer where it was added. Opened on another computer, the media surfaces show a broken image and bare error wording, never saying the original is on the first computer or what to do.

## Why
Beta 24 made notebook media travel; the files that cannot travel now look broken instead of explained.

## Why now
Holdouts H-09 to H-13 fail on main for this (reproduced with a valid 75 MB file).

## Outcome
- On the computer where it was added, the file stays fully usable.
- On every other computer, every media surface (the note, the media library, previews) shows a deliberate placeholder: the file is kept on the computer where it was added, and the supported next step (open it there, or make it smaller so it travels). Never a broken image, a bare error, or wording that suggests it was copied.

## Invariants
- Files under the travelling limit travel exactly as in beta 24 ("media-travels" still passes).
- Nothing over the limit is committed to the GitHub copy.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests with a valid 75 MB picture and a 75 MB PDF across the media surfaces, on the adding computer and on another one.
- The "media-travels" scenario is extended with a file over 50 MB that shows the placeholder on the fresh install. If that needs a change under `.github/`, the pull request description carries the exact workflow change for the release step to add by hand.

## Done means
The change, its tests and the scenario extension exist and pass with the repository's tests.
