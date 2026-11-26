Status: done (merge 4104751ce73844fa5098360508b9395c9e651c69)

Ticket for 2.0.0-beta.24 (plan item 6). Size: light. Depends on: nothing.

## Problem
Scenario `update-keeps-everything` ("an update from the current public version keeps everything") failed in the nightly run of 2026-11-13 on main (690266d) with: `Update now did not start an update (HTTP 200): {"started":false,"message":"You have the newest version, 2.0.0-beta.23. Nothing was changed."}`. The scenario builds a stand-in newer release from the stage's own file (`stand_in_stage` in `scenarios/update-keeps-everything.sh`, which uses the version plus ".handover"). The install's update check did not take that stand-in as newer once main's own version had become the current release.

## Why
This scenario is the proof that updating keeps everything. While it fails, no release can show that.

## Why now
It started failing when main took the 2.0.0-beta.23 version, and it will fail for every release from now on.

## Outcome
Find out why the update check does not take the stand-in as newer: either the version comparison of "X.handover" against "X", or which release list the check reads. Then make the stand-in a release that the check always takes as newer than whatever the install runs, including right after a release step. If the cause is in the product's version comparison, a real user could be told "newest" while a newer release exists: then fix the product, and say so in the pull request.

## Invariants
- The update check never offers an older or equal version as an update.
- Files under `.github/` are not changed; the factory cannot change them.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The pull request names the cause.
- A unit test of the comparison or of the stand-in fails before the fix and passes after it.

## Done means
The cause is written in the pull request, and the test above passes with the repository's tests.
