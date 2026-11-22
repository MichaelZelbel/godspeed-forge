Ticket for 2.0.0-beta.26 (plan item 4). Size: full. Depends on: nothing (continues pull request #614). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
A picture or PDF over the 50 MB travelling limit (and under the 100 MB upload limit) stays on the computer where it was added. Pull request #614 already makes opening it directly on another computer explain where the original is and what to do. The other computer's Media Library still has no card for it, so the person cannot find it by name there. Holdouts H-09, H-11 and H-13 reproduce this (review of head `46d45b7`).

## Why
A file missing from the library looks lost, not kept elsewhere.

## Why now
It was item 6 of beta.25; its last send-back named exactly this gap.

## Owner decision
Decided 2026-11-15 (posted on #531 at 10:21 UTC; repeated here because the loop reads the item): the requirement stands as written. A file that stayed on the other computer appears as a searchable card in the Media Library, with the kept-elsewhere explanation. Approved changes to what any check judges: none looser.

## Outcome
- On the computer where it was added, the file stays fully usable.
- On every other computer, every media surface (the note, the Media Library card and its search, previews, direct opening) shows a deliberate placeholder: the file is kept on the computer where it was added, and the supported next step (open it there, or make it smaller so it travels). Never a broken image, a bare error, or wording that suggests it was copied.

## Invariants
- Files under the travelling limit travel exactly as in beta 24 ("media-travels" still passes).
- Nothing over the limit is committed to the GitHub copy.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests with a valid 75 MB picture and a 75 MB PDF: on the other computer the Media Library lists each by name, search finds it, and its card carries the explanation.
- The "media-travels" scenario covers a file over 50 MB on the fresh install. If that needs a change under `.github/`, the pull request description carries the exact workflow change for the release step to add by hand.

## Done means
The change, its tests and the scenario extension exist and pass with the repository's tests.
