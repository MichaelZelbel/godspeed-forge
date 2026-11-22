Ticket for 2.0.0-beta.26 (plan item 3). Size: light. Depends on: nothing (continues pull request #605; its hidden-scenario evidence uses the browser verifier that #620 repairs, which is built separately). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
Asking any chat for "today's briefing" can return something other than the saved morning briefing: incomplete, filtered differently, or without the same next step and Charm Challenge line. Pull request #605 carries the fix. Its last review (head `b316e32`) found four newly added verifier tests failing for one reason: they spawn `notebook/scripts/...` relative to the working directory, and `npm test` runs from `notebook/`, so Node looks for `notebook/notebook/scripts/...`; the AI stand-in exits and its two callers get `ECONNREFUSED`. The hidden-scenario check could not establish H-04, H-05, H-06 and H-18 on that head.

## Why
The person gets two different briefings depending on where they ask.

## Why now
It was item 4 of beta.25 and reached its cap there on a test path bug, not on the product change.

## Owner decision
Decided 2026-11-15 by Mission Control as a question of how: the tests resolve their scripts from their own file's location, never from the working directory. The acceptance stays exactly as written; no check is loosened.

## Outcome
"Today's briefing" asked in any chat (floating, note, collection, pop-out, Telegram) returns the saved briefing of the day, with the same next step and Charm Challenge line; when no briefing was saved today, it says so plainly, never a substitute.

## Invariants
- The saved briefing is never changed by being read through a chat.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The notebook package suite passes whole on the exact head, run from `notebook/` as documented.
- The scenario "today's brief asked in the chat is the morning briefing" passes.
- Tests for the no-briefing-today case.

## Done means
The change and its tests exist and pass with the repository's tests.
