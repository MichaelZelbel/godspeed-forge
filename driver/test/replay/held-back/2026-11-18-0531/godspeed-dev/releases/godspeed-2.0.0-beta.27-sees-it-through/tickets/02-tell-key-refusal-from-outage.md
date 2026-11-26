Ticket for 2.0.0-beta.27 (plan item 2). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #590.

## Owner decision

The existing AI-state holdouts keep what they judge. Test and fixture changes may correct attribution or make the bar stricter, but may not merge refused keys with outages, omit a supported surface, expose a secret, or allow an open chat to remain stale. Continuing the existing correction work is approved.

## Problem

When an AI provider refuses a key, chats, model choices and the AI card describe the problem as a general outage. A chat that is already open can also keep an old state after the connection changes.

## Why

Someone with a wrong or expired key needs to know that the key needs attention. Telling them to wait for an outage wastes time, while a stale status makes recovery appear not to work.

## Why now

The correction already exists in part, but previous release attempts reached their cap before the whole visible behavior and its tests were complete.

## Outcome

Every supported place that shows AI availability identifies a refused key and gives a useful next step. Timeouts, provider server errors and unreachable services remain outages. An open chat notices a changed state within about five seconds without a reload.

## Invariants

- Existing AI-state holdouts keep the same requirements.
- Never display, log or send a key, token or fragment of one anywhere new.
- A provider refusal must not be described as an outage, and an outage must not be described as a refused key.
- Recovery checking must not submit chat content or create another outward action.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- Automated tests distinguish refused credentials from timeouts, provider errors and network failures in chats, model choices and the AI card.
- Tests cover both common refusal responses from a provider.
- A test leaves a chat open, changes the AI state, and observes the corrected state within about five seconds without reloading.
- The repository tests and integrated installed-product check pass.

## Done means

The continuing change covers every named surface, keeps secrets private, refreshes an open chat, and passes its focused and repository checks.
