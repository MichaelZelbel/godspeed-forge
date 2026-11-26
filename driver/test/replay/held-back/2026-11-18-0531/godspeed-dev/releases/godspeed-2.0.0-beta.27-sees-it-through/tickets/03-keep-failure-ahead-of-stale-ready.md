Ticket for 2.0.0-beta.27 (plan item 3). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #667.

## Problem

When two AI availability reads overlap, a shared connection check can fail while another reader still reuses an older ready result. The chat can briefly invite the person to use an AI connection that has just failed.

## Why

The status should describe the newest known result. Showing ready after a failure is misleading and can send a person into an action that cannot work.

## Why now

The race was found while correcting the wider AI-state behavior and remains open in its continuing change.

## Outcome

A failed shared connection check takes precedence over every cached ready result used by overlapping readers. Ready is shown again only after a newer check succeeds.

## Invariants

- A successful check still reaches the ready state as quickly as it does now.
- Do not add provider requests beyond those needed by the existing availability behavior.
- Do not expose or newly transmit credentials.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- A deterministic concurrency test overlaps two readers with one failing shared check and proves that neither reader reports ready.
- A companion case proves that a newer successful check can restore ready.
- Existing fast successful behavior remains covered.
- The repository tests and integrated installed-product check pass.

## Done means

The continuing change enforces the ordering rule and its deterministic concurrency tests pass.
