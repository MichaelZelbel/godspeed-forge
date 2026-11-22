Ticket for 2.0.0-beta.27 (plan item 1). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #679.

## Owner decision

The fresh-server check keeps every existing assertion and timeout. Changes may make its startup simulation more faithful or stricter, but may not give the server more time, skip startup work, or accept the reconnect error.

## Problem

Immediately after a server restart, the notebook's first request can arrive before startup work has finished. The sign-in gate stops waiting and shows a reconnect message even though the server becomes healthy shortly afterward.

## Why

A routine restart should return a person to the notebook. Meeting an error page makes a healthy server look broken and also causes unrelated changes to need check reruns.

## Why now

The installed-product check guards every merge, and this intermittent startup failure can delay any bug fix in the release.

## Outcome

The notebook answers promptly after a restart. When required startup work is still running, the gate says the server is starting, waits for readiness, and then opens the requested page without showing the reconnect error.

## Invariants

- Keep every assertion and timeout in the fresh-server check.
- Do not skip verification, indexing, synchronization or other startup work needed for correct data.
- Move work later only when the notebook can answer correctly while that work continues.
- Do not perform a new outward action during startup.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- The pull request records what runs during the first seconds after restart, its timings, and the measured cause of the late first answer.
- An automated test delays the responsible startup step, shows the gate waiting, and then opens the requested page.
- That test proves a server that is merely starting never produces the reconnect error.
- The repository tests and integrated installed-product check pass without longer timeouts.

## Done means

The measured cause is recorded, the restart behavior is corrected, and the reproducing test passes with the repository's checks.
