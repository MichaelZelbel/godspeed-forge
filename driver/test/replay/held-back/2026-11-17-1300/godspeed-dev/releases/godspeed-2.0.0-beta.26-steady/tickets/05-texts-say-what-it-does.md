Ticket for 2.0.0-beta.26 (plan item 5). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #664.

## Problem
Texts in this repository say what the code no longer does:
1. In `notebook/core/starting-routines.mjs`, the Deadline reminders' description says "With a morning brief switched on, your dates are in the brief instead", and the daily round's says "With a morning brief switched on, the brief tells you instead". `starter-godspeed/procedures.md` (around line 105) says the same. Since the notebook's own briefing (#160), the reminders and the daily-round line always speak for themselves (`starting-routines.test.mjs`, "beside the notebook's own morning briefing the deadline reminders speak for themselves").
2. `notebook/ui/src/local/RecordSync.tsx` (around line 18), under Private GitHub repository, says "Keys, media and search databases stay outside Git". Since beta.24, pictures and PDFs of 50 MB or less are in `notebook/_media/` and in the GitHub copy (`media-store.mjs`).
3. `starter-godspeed/AGENTS.md` (around lines 43 to 51) fetches the book's ready-made skills from raw `main`, while people run the public release on `beta`.

## Why
A person reads these on screen or in their starter files and is told the opposite of what happens.

## Why now
The maintainer found them on 2026-11-16 while checking his book against the release.

## Outcome
Each text says what the code does, and the book's skills are fetched from the public `beta` line.

## Invariants
- Behaviour does not change, only the texts. The one exception: if the test below shows that `memory-daily.mjs` overwrites a value the person typed into the notebook themselves, the code is fixed so such a value is never overwritten.
- The guide pages live in the website repository and are not part of this change; the plan's "After go" carries them.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests assert the corrected texts (the reminders' and daily round's descriptions, the RecordSync text) and that `starter-godspeed/AGENTS.md` fetches from `beta`.
- One test shows whether the daily facts routine (`memory-daily.mjs`) can close an older fact the person typed themselves. It must not, and the code is fixed if it does.
- The product's tests and "Integrated Godspeed v2" pass.

## Done means
The text changes and tests exist and pass with the repository's tests.
