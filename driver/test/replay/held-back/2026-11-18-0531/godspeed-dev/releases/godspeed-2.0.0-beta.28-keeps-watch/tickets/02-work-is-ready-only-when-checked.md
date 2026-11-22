Ticket for 2.0.0-beta.28 (plan item 2). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #279.

## Owner decision

Changes to what a work item's check judges may only make it stricter: a check must read the result against the task's own done-means. No check may become looser, and no scenario may accept a result it refuses today.

## Problem

On an established installation, the daily work round marked a five-slide talk draft verified because its check counted five `##` headings, and a research file verified because it passed 500 words. The same day's morning message repeated an old seven-item approval list, including proposals already past their closing dates, while the current decision named two live ones.

## Why

A result called ready must be one the person can use. Counting headings or words proves a file exists, not that it is accurate, complete or fit for its goal; and a morning message that lists closed approvals asks the person to decide things that are already decided.

## Why now

Every plan since 2.0.0-beta.25 deferred this issue; it needs no owner answer, only this decision, and it affects every long-running installation.

## Outcome

- A work item is called verified only when its check compares the result with the task's own done-means (content, not size or shape). A result that only has the right shape stays unverified and says what is missing.
- The morning message takes approvals only from the current decision and from waiting steps that are still pending; closed, answered or expired ones never appear.

## Invariants

- Do not loosen any existing check or scenario; #268 (private publication) stays separate and untouched.
- Do not add an outward action.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- A test with a draft whose headings or word count meet the old check but whose content misses the done-means leaves it unverified, with the missing part named.
- A test with a matching result marks it verified.
- A test with an old approval list in the workspace and a current decision naming two live proposals produces a morning message naming only those two.
- The installed established-workspace scenario covers both paths; repository tests and the integrated check pass.

## Done means

Both behaviours are fixed in the product and proved by the tests above in the builder's copy.
