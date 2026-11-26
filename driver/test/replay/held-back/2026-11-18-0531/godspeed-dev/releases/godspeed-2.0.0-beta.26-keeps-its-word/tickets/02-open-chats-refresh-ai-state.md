Ticket for 2.0.0-beta.26 (plan item 2). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control.

## Problem
Pull request #601 (merged) made every chat say before typing whether an AI is connected and usable. One part is left: a chat that is already open when the person connects an AI keeps showing "No AI connected" in its model picker and status text, although it can already send through the new AI. The reverse (an AI that stops working while a chat is open) has the same gap. Holdout H-23 fails on main `7c9f232f` for this.

## Why
The chat contradicts itself: it says there is no AI and then answers.

## Why now
It is the rest of beta.25's item 2, parked there at the send-back cap only because the refresh timing needed a decision, now taken.

## Owner decision
Decided 2026-11-15 (posted on #531 at 10:21 UTC; repeated here because the loop reads the item): every open chat refreshes its AI state on its own within about 5 seconds, with no reload and no focus needed. This is the same window beta.25's item 3 accepted. Approved changes to what any check judges: none looser.

## Outcome
Every open chat surface (floating, note, collection, pop-out) shows the current AI state within about 5 seconds of a change (connected, removed, refused or unreachable), without a reload or a focus change.

## Invariants
- A working AI is never shown as unavailable.
- The refresh is light: one short bounded status check shared by the open surfaces, never a request per keystroke or an unbounded loop; it stops when no chat is open.
- No secret or raw provider error text is shown.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests per chat surface: open with no AI, connect one, the surface shows it within 5 seconds; and the reverse.
- The notebook web page's unit tests and type check pass.

## Done means
The change and its tests exist and pass with the repository's tests.
