Ticket for 2.0.0-beta.24 (plan item 2). Size: light. Depends on: nothing.

## Problem
In the nightly run of 2026-11-13 on main (690266d), the AI wrote the morning brief, the source check refused its opening sentence ("nothing from the calendar needs attention", but no calendar read appears in the sources), and then the checked factual fallback was refused as well. The routine exited with code 1 and saved no brief: "The morning brief could not be written. Could not make a checked factual fallback: source-facts: ...". The code is `notebook/core/briefing.mjs`, around the two "Could not make a checked factual fallback" errors. The scenario `briefing-breaks-a-rule` ("a briefing that breaks a rule still arrives") exists exactly for this, and it failed.

## Why
The brief is the person's daily touchpoint. A check that leaves them with no brief at all is worse than a brief with one sentence removed.

## Why now
Seen last night on the public code. It depends on the AI's wording, so it will recur on real installs.

## Outcome
- A sentence the source check refuses is dropped from the brief, or replaced by one that states only what the sources show, and the brief is saved with what passed.
- When nothing passes, the brief still arrives as the short honest note the fallback is meant to write. That note is built only from facts the sources hold, so the fallback itself can never be refused for a claim about something it did not read.
- The brief is never lost to the check.

## Invariants
- No sentence that fails the source check, a rule check or the code gate reaches the saved brief.
- A brief that passes today is saved unchanged.
- The routine's error exit stays for real failures (no source readable at all, a disk error), with its reason.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A unit test, beside `notebook/test/briefing-never-lost.test.mjs`, where the AI's opening claims the calendar was clear with no calendar read: the brief is saved without that claim.
- A unit test where every AI sentence is refused: the honest short note is saved and the routine exits 0.

## Done means
Both tests exist and pass with the repository's tests.
