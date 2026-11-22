Ticket for 2.0.0-beta.25 (plan item 2). Size: light. Depends on: nothing (continues pull request #601; rebase onto item 3 if it merges first). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
With no AI connected, or with an AI whose key is refused, the floating, note, collection and pop-out chats show their usual header and empty-chat text. Only the Model picker and its tooltip tell the AI's state, so a person who has not opened the picker sees a chat that looks ready.

## Why
The person types into a chat that cannot answer and learns why only from an error afterwards.

## Why now
Holdouts H-19, H-20 and H-22 fail on main for this; it is most of the AI-state work the maintainer will try in this release.

## Owner decision
Decided 2026-11-15 on the owner-decisions issue (question on the health-check budget): the status check gets its own short request budget in the provider contract, distinct from the 300000/600000 budgets of ordinary requests, so a usable AI is never shown as unavailable because the probe was refused.

## Outcome
Where a person looks before typing (the chat's header or its empty-chat text), every chat says that no AI is connected, or that the connected AI could not be used, and points to Settings, Your AI. With a working AI the chats look as today.

## Invariants
- A working AI is never shown as unavailable.
- The status check is short and bounded; it never becomes a long request or a loop.
- No secret or raw provider error text is shown to the person.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests for each chat surface in the three states: working, none connected, refused or unreachable.
- Tests for the provider contract's short health-check budget.
- The notebook web page's unit tests and type check pass.

## Done means
The change and its tests exist and pass with the repository's tests.
