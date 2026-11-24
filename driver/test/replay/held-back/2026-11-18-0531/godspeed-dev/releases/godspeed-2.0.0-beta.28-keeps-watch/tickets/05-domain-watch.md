Ticket for 2.0.0-beta.28 (plan item 5). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #706.

## Problem

The product has a `domain-watch` job kind that the notebook already schedules (`NativeScheduler.recordKinds`), but it shares the generic page-change code in notebook/core/procedures.mjs: it never asks a domain registry whether a domain is free, and no chat command or Settings entry creates one. docs/full-version/acceptance-matrix.json lists it as "source only".

## Why

A person waiting for a web address they want needs to hear the moment it can be registered, and ideally days before, while a backorder is still possible. The maintainer's server has done this every six hours with a private job.

## Why now

The owner approved moving this private job into Godspeed (plan 2.0.0-beta.28, 17 November 2026), so his server can drop its private copy.

## Outcome

- The person adds or removes a watched domain in the chat ("watch the domain example.com", "stop watching example.com") and in Settings, which lists them.
- Every six hours each domain is looked up over RDAP, the public registry protocol, free and without a key: `https://rdap.verisign.com/com/v1/domain/<name>` for .com and `https://rdap.verisign.com/net/v1/domain/<name>` for .net, otherwise `https://rdap.org/domain/<name>` with `https://www.rdap.net/domain/<name>` as the fallback. HTTP 404 means available; otherwise the status values decide: `pending delete` gives pending delete, `redemption period` gives redemption, anything else registered.
- One notice per change of state, with fixed advice per state: available ("it can be registered now, at any registrar"), pending delete ("it is released in about five days; a backorder service can try to catch it"), redemption ("the owner can still renew it for about 30 days"), registered (only when it changes back). No notice while the state stays the same.
- Requests send `Accept: application/rdap+json` and a generic User-Agent naming Godspeed (rdap.org refuses a bare library User-Agent with 403), never a person's name or mail address.

## Invariants

- Never register, backorder or buy anything: notice only.
- A lookup that fails on every server is not a state change; it is retried next run.
- Page-change watches (`watch`, `portfolio`) keep their current behaviour.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- Tests with stubbed RDAP: registered, then pending delete, then available gives exactly one notice per change; a repeated answer gives none; a failure on the first server falls back to the second; a total failure gives no notice; .com and .net use the Verisign server.
- Tests for adding, listing and removing a domain from the chat and Settings.
- Repository tests and the integrated check pass; the acceptance matrix row for domain-watch names its evidence.

## Done means

The lookup, the commands and their tests exist in the builder's copy and pass.
