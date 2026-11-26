Ticket for 2.0.0-beta.27 (plan item 4). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #670.

## Owner decision

The installed product may be corrected so its listed coaching preparation has every required installed and registered part. The preparation-quality rules and coaching holdouts remain unchanged. Fixtures or routes may be corrected or tightened, but a preparation that fails those rules may never be called ready.

## Problem

On a normal installation, running the visible coaching-talk preparation for the supported clean example produces a draft instead of a ready preparation. The talk therefore opens without the preparation it was meant to use.

## Why

The preparation is made in advance so a coaching talk can begin with useful context. A listed routine that cannot produce its valid ready result breaks that promise.

## Why now

The work was deliberately deferred from the previous releases and then reached the factory's correction cap. It is unfinished bug work, not a new coaching feature.

## Outcome

Through the same visible selector and Run now action a person uses, the supported clean example produces a ready, usable preparation and the talk opens from it. A preparation that does not meet the existing quality rules stays a draft and explains why.

## Invariants

- Keep every existing preparation-quality requirement and coaching holdout unchanged.
- Do not manufacture ready state through private helpers or test-only data.
- A genuinely insufficient preparation remains a draft with an explanation.
- Installation changes must not add permissions or unrelated capabilities.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- An installed-boundary test uses the visible preparation selector and Run now action for the supported clean example.
- The result is ready, contains a usable preparation, and opens the talk from that preparation.
- A second installed-boundary test uses an insufficient example and receives a draft with a reason.
- The repository tests and integrated installed-product check pass.

## Done means

A normal installation can produce both correct outcomes through the visible user path, and both installed-boundary tests pass.
