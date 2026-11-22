Ticket for 2.0.0-beta.28 (plan item 3). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #704.

## Problem

A person who runs Godspeed on their own OpenRouter key has no warning when a day's AI spending runs away or the credit is about to run out. The product has a `spend-guard` job kind that only calls a generic `run-connector` (notebook/core/procedures.mjs), a balance connector the person must configure by hand, nothing that schedules either, and no daily-spend check at all. docs/full-version/acceptance-matrix.json lists spend-guard as "source only".

## Why

A routine that loops, or a model priced higher than expected, can spend a person's money overnight. The maintainer's own server has caught this hourly since August with a private job; every user should have the same protection.

## Why now

The owner approved moving this private job into Godspeed (plan 2.0.0-beta.28, 17 November 2026), so his server can drop its private copy.

## Outcome

- For each OpenRouter key the installation holds, the notebook calls `GET https://openrouter.ai/api/v1/key` (fields `usage_daily`, `limit`, `limit_remaining`) and `GET https://openrouter.ai/api/v1/credits` (balance). This is the mechanism of the proven private job; the product's acceptance test notebook/test/acceptance/goal-loop-inside.sh already calls `/api/v1/key`.
- One plain notice when the day's total spending across keys passes the daily limit, and one when the credit balance falls below the low-balance amount; each kind at most once every six hours. The notice names the amount spent or left, the limit, and where to change it.
- Defaults: 2 USD a day, 5 USD of credit. Both are settings the person can change in Settings, and the check can be switched off there.
- It runs hourly as a record routine of the notebook's own scheduler (beside `watch` in `NativeScheduler.recordKinds`, notebook/core/native-scheduler.mjs), on by default whenever an OpenRouter key exists, and silent when none exists.
- The old `spend-guard` connector path and the hand-configured balance connector are replaced by this, not left beside it. Where the AI provider is not OpenRouter, Settings says plainly that spending is not checked for that provider yet.

## Invariants

- Never print or store a key in a notice, a log or a record; keys are read only from where the product already keeps them.
- No outward action besides the two read-only calls and the notice to the person; never change a key's limit.
- A failed call is not a notice of spending; it is recorded and retried next hour, and only the existing connection check speaks about a broken key.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- Tests with a stubbed OpenRouter: 2.50 USD spent today gives exactly one notice in six hours; 1 USD gives none; a balance of 4 USD gives one low-balance notice; no OpenRouter key gives no call and no notice; a failed call gives no notice.
- A test proves the threshold settings change the outcome and the off switch stops the calls.
- A test proves no key text appears in notices, logs or records.
- Repository tests and the integrated check pass.

## Done means

The routine, its settings and its tests exist in the builder's copy and pass; the acceptance matrix row for spend-guard names its evidence.
