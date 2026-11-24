Status: done (merge 7c9f232f04850ca0d9b886a9d9acdea4fb5797ee)

Ticket for 2.0.0-beta.25 (plan item 7). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control.

## Problem
The scenario "two computers that move the same reminders at once" failed on the 2.0.0-beta.24 candidate run and on the nightly of 14 November because GitHub's anonymous request limit (60 an hour, shared by the test machines) answered the notebook copy's privacy check with 403, so `godspeed sync folder` was refused on the second computer and it never joined. Since #562 the refusal names the rate limit; the scenario still fails.

## Why
A proof that fails for GitHub's rate limit says nothing about Godspeed and teaches everyone to ignore it.

## Why now
It is the only older scenario that keeps failing for a reason outside the product.

## Owner decision
Approved in the plan of 2.0.0-beta.25: inside the scenario, the privacy check may use an authenticated GitHub request (the workflow's own token) or a cached answer for the same repository within the run. No looser case: the scenario must still fail when the notebook copy is public or when the privacy check is skipped. If the change needs a file under `.github/`, the pull request description carries the exact change for the release step to add by hand.

## Outcome
The scenario judges Godspeed's behaviour when two computers move the same reminders at once, not GitHub's request limit.

## Invariants
- The product's privacy check itself is unchanged for people using Godspeed: it still refuses a public copy and still says why when GitHub cannot answer.
- The scenario's bar is equal or stricter.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The scenario passes when the privacy check is answered and still fails on a public copy (a test or a scenario variant shows this).
- The product's tests pass.

## Done means
The scenario change and its proof exist and pass with the repository's tests.
