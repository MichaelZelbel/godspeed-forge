Status: done (merge 15fabf89b7dc681ac4a5ffb60aebe1aca9be63b7)

Ticket for 2.0.0-beta.26 (plan item 4). Size: light. Depends on: nothing (continues pull request #672). Repository: MichaelZelbel/godspeed-mission-control. Issue: #669.

## Problem
In the installed browser, after creating a person and opening Add Moment, there is no usable control that attaches that existing person to the moment. Holdout H-32 shows it, and it reproduces on main and on PR #618.

## Why
Linking a moment to someone the person already has is what the People field is for. Beta.25 added creating a new person from the dialog, but choosing an existing one does not work.

## Why now
It is a visible gap right next to what beta.25 just shipped.

## Outcome
Add Moment lets the person choose any existing person, by mouse and by keyboard, with or without Suggest with AI, and the saved moment shows that person.

## Invariants
- Adding a new person from the dialog (beta.25) keeps working.
- Moments without people save as today.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A browser-level test creates a person, opens Add Moment, picks that person, saves, and finds the person on the moment.
- The product's tests and "Integrated Godspeed v2" pass.

## Done means
PR #672's change with its test passing.
