Ticket for 2.0.0-beta.26 (plan item 7). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #670.

## Problem
On an installed Godspeed, the `Coaching talk preparation` routine, reached through its visible selector and Run now, produces `STATE: draft` for the supported clean fixture. A coaching talk therefore cannot open from a ready preparation, and holdouts H-14..H-17 stay incomplete.

## Why
The coach prepares a talk the day before so the person gets a ready talk. A draft means the talk opens without its preparation.

## Why now
Michael moved it out of beta.25 into a later release, and this is that release.

## Outcome
For the supported clean fixture, the installed routine produces a ready, usable preparation through the same public boundary a person uses, and the talk opens from it.

## Invariants
- The preparation-quality requirements and every holdout check (H-14..H-17) stay unchanged.
- A preparation that really does not meet the requirements still comes out as a draft and says so; the scenario "a talk says when its preparation did not pass" keeps passing.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A test on the installed boundary runs the routine for the clean fixture and gets `STATE: ready` with a usable preparation.
- A test with a fixture that fails the requirements still gets a draft that says why.
- The product's tests and "Integrated Godspeed v2" pass.

## Done means
The change and both tests exist and pass with the repository's tests.
