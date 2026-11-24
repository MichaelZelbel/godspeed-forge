Ticket for 2.0.0-beta.26 (plan item 2). Size: full. Depends on: nothing (continues pull request #660). Repository: MichaelZelbel/godspeed-mission-control. Issue: #590.

## Problem
When the provider refuses the AI key (401 or 403), the chats, the model pickers and the AI card treat it like an outage, so the person is not told that the key is the problem. Holdouts H-19..H-26 and H-29 fail on main because of this, and because the chats do not show the AI's state at all (#590 lists each holdout).

## Why
A person with a wrong or expired key needs to hear "your key was refused, here is where to fix it", not "the AI is unavailable, try later".

## Why now
Beta.25 moved this out (its items 2 and 3) when it reached the factory's cap; PR #660 carries most of it.

## Outcome
Everywhere the AI's state is shown, a refused key is said as a refused key, with what to do. An outage (timeout, 5xx, no route) is said as an outage. An open chat notices a change within about five seconds without a reload.

## Invariants
- The holdouts H-19..H-26 and H-29 judge it unchanged.
- No key, token or part of one is shown, logged or sent anywhere new.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests cover refused (401, 403) versus outage (timeout, 5xx, network) for the chats, the pickers and the card.
- A test shows an open chat changing its state within about five seconds of the change, without a reload.
- The product's tests and "Integrated Godspeed v2" pass.

## Done means
PR #660's change, completed, with its tests passing.
