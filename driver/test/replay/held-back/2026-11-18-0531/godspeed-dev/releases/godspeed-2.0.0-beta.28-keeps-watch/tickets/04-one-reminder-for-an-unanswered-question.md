Ticket for 2.0.0-beta.28 (plan item 4). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #705.

## Problem

When Godspeed asks the person a yes-or-no question through a waiting step (notebook/core/waiting-steps.mjs, skill ask-for-a-yes), nothing follows up if it goes unanswered: the step sits until it expires, and the work behind it waits silently.

## Why

A question lost in a busy chat stalls the work it guards. The maintainer's server has sent one follow-up for such questions hourly with a private job (one reminder after six hours, never twice).

## Why now

The owner approved moving this private job into Godspeed (plan 2.0.0-beta.28, 17 November 2026), so his server can drop its private copy.

## Outcome

- Once an hour, every waiting step that is pending, whose question was delivered (`sent_at` set, or a legacy step without a chat), was sent more than six hours ago and less than seven days ago, and is not expired, gets exactly one reminder in the same chat it was asked in.
- The reminder stands on its own: what it is about, the question, and how to answer, in the step's own words.
- A marker on the step is written only after the reminder was sent successfully; a failed send is retried the next hour; a step with a marker is never reminded again. Answering the original or the reminder answers the step as today.

## Invariants

- Waiting steps' answer rules, expiry and the words that count as yes or no do not change.
- A reminder never repeats an outward action and never answers a step by itself; quiet kinds (`QUIET_KINDS`) are never reminded.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- Tests: a step sent 6 h 10 min ago gets one reminder; an hour later nothing more; a step sent 5 h ago gets none; one older than seven days or expired gets none; a failed send writes no marker and the next run sends; an answered step gets none.
- Repository tests and the integrated check pass.

## Done means

The hourly follow-up and its tests exist in the builder's copy and pass.
