Status: done (merge 2dad4cade5d0e5d2ff44e48c2389fbe4b1cdf9c9)

Ticket for 2.0.0-beta.25 (plan item 4). Size: light. Depends on: nothing (continues pull request #605). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
After the morning briefing is filtered and saved, asking for it through the different chat surfaces does not reliably return that saved briefing: one path drafts a different version with no concrete next step, others leave out the filtered briefing or its Charm Challenge line.

## Why
The person gets different versions of the same day's briefing depending on where they ask.

## Why now
Holdouts H-04, H-05 and H-06 fail on main for this, and the pull request is close to done.

## Outcome
Every supported chat surface returns the same saved, filtered briefing for the day. Its next step and Charm Challenge line are present exactly when they are in the saved briefing. No surface drafts a substitute.

## Invariants
- The briefing's own filtering (sentences the source check refuses are dropped) is unchanged.
- When there is no saved briefing for the day, the surfaces behave as today.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests for each chat surface, including a briefing with a filtered-out sentence and one with and one without a Charm Challenge line.
- "today's brief asked in the chat is the morning briefing" still passes.

## Done means
The change and its tests exist and pass with the repository's tests.
