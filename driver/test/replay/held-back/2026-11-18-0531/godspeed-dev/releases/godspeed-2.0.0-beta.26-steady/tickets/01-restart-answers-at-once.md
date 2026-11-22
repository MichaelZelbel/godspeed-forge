Ticket for 2.0.0-beta.26 (plan item 1). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #679.

## Problem
Right after `docker restart`, the server can take more than 15 seconds to answer its first `/api/query`. The sign-in gate (`hydrateFileChats` in `notebook/ui/src/local/file-chat.ts`, and `file-preferences.ts`) gives up after 15 seconds and shows "Let's reconnect. Your server is busy saving and did not answer in time." Seen on 2026-11-16 in "Integrated Godspeed v2" run 43814147068 (first attempt) on a change that touched only a data file; the rerun passed.

## Why
A person who restarts their server meets an error screen instead of their notebook. Since product PR #678 the integrated tests also gate every pull request, so an intermittent failure here costs a rerun on any change.

## Why now
It is the one intermittent failure in the check that now guards every merge.

## Outcome
After a restart the notebook answers its first request promptly. If startup work must finish first, the gate shows that the server is starting and waits for it to be ready instead of failing with "busy saving".

## Invariants
- The fresh-server check (`docker/full-candidate/test.sh`, `test-browser.cjs ... resumed`) keeps every assertion and timeout as it is.
- No startup work that keeps data correct (store verification, index consistency, sync) is skipped. It may move to the background only where the notebook already answers correctly meanwhile.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The pull request names the measured cause: what the server does in its first seconds after a restart, with timings.
- A test reproduces a slow first answer after restart (for example by delaying the startup step that was found). It shows the gate waiting and then opening the requested page, and never showing "busy saving" for a server that is only starting.
- The product's tests and "Integrated Godspeed v2" pass.

## Done means
The change, its measurement and its test exist and pass with the repository's tests.
