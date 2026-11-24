Ticket for 2.0.0-beta.24 (plan item 1). Size: light. Depends on: nothing.

## Problem
When the person asks for a coaching talk and the AI's first reply misses the health talk's required preparation sentence (when the preparation did not pass) or does not use the prepared opening (when it did), the notebook answers HTTP 400 with the guard's reason. The person sees an error instead of a talk. The guard lives in `notebook/core/coach-chat.mjs` ("required preparation sentence", "prepared opening").

## Why
The guard exists so a talk never opens on something its preparation did not check. Refusing the wrong opening is right; leaving the person with nothing is not.

## Why now
The candidate run of 2.0.0-beta.23 failed `talk-prep-honest` twice on the scenario AI (anthropic/claude-haiku-5.5 via OpenRouter), at two different parts, while main passed the same job earlier that day: it depends on what the AI writes. The maintainer took beta.23 public over it and asked for the fix next.

## Outcome
A reply that fails the guard is asked for once more, with the guard's reason given to the AI. If the second reply still fails, the talk opens from the record itself: the prepared opening when the preparation passed, the honest "the preparation is not ready" sentence when it did not, followed by the talk's usual question. The person never gets an error for this.

## Invariants
- The guard never lets a wrong opening through: no reply that fails it reaches the person.
- At most two AI calls for one talk start; no loop.
- Talks whose first reply is right behave exactly as today.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A unit test where the AI's reply misses the opening once: the second reply is used.
- A unit test where it misses twice: the talk opens from the record, HTTP 200, no error text, with the prepared opening (or the not-ready sentence, in the not-passed case).
- The existing coach-chat tests pass.

## Done means
Both tests exist and pass with the repository's tests.
