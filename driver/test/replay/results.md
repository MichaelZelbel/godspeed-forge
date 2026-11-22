# Replay of the recorded stalls

Written by `node replay.mjs --write`. Each stall is a stretch in the factory scheduler's log (2026-11-13 to
2026-11-18) in which it started no new work for two hours or more. The driver's own world reader runs on the
GitHub timelines (labels, state, comments, pull requests, required checks), the scheduler's decision lines and
godspeed-dev's release plans as they stood at that moment; a round at the stall's start plus 30 minutes judges
it, after rounds every 30 minutes for the 12 hours before so that the ledger has a history. A stall passes when
at least one obstacle has a next step that is not a wait.

What the record cannot say, and the replay therefore does not claim: which laps were running (the scheduler's
own "N lap(s) active" is what counts), the state of main (never red in the replay), whether a STOP file existed,
the exact time a release was staged (auto-stage's state file is empty), and hidden-check results.

The two held-back stalls (2026-11-17 13:00 and 2026-11-18 05:31) are built by the same builder and run by the same
code; their fixtures live in `held-back/`, no test runs the driver on them, and no driver code is changed after
looking at their result. A failing held-back stall is a finding to report, not a thing to tune for.

Known approximations (found in review): a pull request that merely mentions an issue counts as linked to it (GitHub's
own "closing" link is not in the timelines); and the first round is judged with an empty history, so for an ordinary
obstacle the ladder's first step, "diagnose", is what passes: the replay proves that the driver would have SEEN the
stall and acted within its first round, not that the action would have ended it.

## Stalls the driver was built against

### 2026-11-14-0253 (2026-11-14T02:53:00+01:00): PASS

- release read: godspeed-2.0.0-beta.23-side-by-side (0 tickets), godspeed-2.0.0-beta.24-never-empty-handed (6 tickets); open items with needs-owner on the board: 9
- scheduler said: "2026-11-14T03:05:17+01:00 No launch: the last lap found nothing to start on this same board (workable #510)." / "2026-11-14T03:11:17+01:00 No launch: the last lap found nothing to start on this same board (workable #510)." / "2026-11-14T03:17:17+01:00 No launch: the last lap found nothing to start on this same board (workable #510)."
- obstacle factory-idle godspeed-mission-control (since 2026-11-13T22:37:51.000Z) -> diagnose with claude/sonnet

### 2026-11-14-2349 (2026-11-14T23:49:00+01:00): PASS

- release read: godspeed-2.0.0-beta.24-never-empty-handed (6 tickets); open items with needs-owner on the board: 14
- scheduler said: "2026-11-15T00:05:11+01:00 No launch: the last lap found nothing to start on this same board (workable #590)." / "2026-11-15T00:10:18+01:00 No launch: the last lap found nothing to start on this same board (workable #590)." / "2026-11-15T00:15:43+01:00 No launch: the last lap found nothing to start on this same board (workable #590)."
- obstacle factory-idle godspeed-mission-control (since 2026-11-14T14:36:17.000Z) -> diagnose with claude/sonnet

### 2026-11-17-0701 (2026-11-17T07:01:00+01:00): PASS

- release read: godspeed-2.0.0-beta.25-says-what-is-true (5 tickets), godspeed-2.0.0-beta.26-steady (10 tickets); open items with needs-owner on the board: 17
- scheduler said: "2026-11-17T07:13:19+01:00 No launch: the last lap found nothing to start on this same board (workable #679)." / "2026-11-17T07:19:19+01:00 No launch: the last lap found nothing to start on this same board (workable #679)." / "2026-11-17T07:25:19+01:00 No launch: the last lap found nothing to start on this same board (workable #679)."
- obstacle parked godspeed-2.0.0-beta.25-says-what-is-true#4 (since 2026-11-16T18:01:00.000Z) -> diagnose with claude/sonnet
- obstacle no-progress godspeed-2.0.0-beta.26-steady#1 (since 2026-11-16T18:01:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.26-steady#2 (since 2026-11-16T18:01:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.26-steady#3 (since 2026-11-16T18:01:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.26-steady#7 (since 2026-11-16T18:01:00.000Z) -> diagnose with claude/sonnet
- obstacle factory-idle godspeed-mission-control (since 2026-11-16T18:13:18.000Z) -> diagnose with claude/sonnet

## Held back (built the same way, only ever run; no code is tuned on these)

### 2026-11-17-1300 (2026-11-17T13:00:00+01:00): PASS

- release read: godspeed-2.0.0-beta.25-says-what-is-true (5 tickets), godspeed-2.0.0-beta.26-steady (7 tickets); open items with needs-owner on the board: 18
- scheduler said: "2026-11-17T13:17:19+01:00 No launch: workable nothing; 1 lap(s) active, 0 still choosing." / "2026-11-17T13:23:19+01:00 No launch: workable nothing; 1 lap(s) active, 0 still choosing." / "2026-11-17T13:29:19+01:00 No launch: workable nothing; 1 lap(s) active, 0 still choosing."
- obstacle parked godspeed-2.0.0-beta.25-says-what-is-true#4 (since 2026-11-17T00:00:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.26-steady#3 (since 2026-11-17T02:00:00.000Z) -> diagnose with claude/sonnet

### 2026-11-18-0531 (2026-11-18T05:31:00+01:00): PASS

- release read: godspeed-2.0.0-beta.27-sees-it-through (4 tickets), godspeed-2.0.0-beta.28-keeps-watch (5 tickets); open items with needs-owner on the board: 20
- scheduler said: "2026-11-18T05:43:20+01:00 No launch: workable nothing; 1 lap(s) active, 0 still choosing." / "2026-11-18T05:49:19+01:00 No launch: workable nothing; 1 lap(s) active, 0 still choosing." / "2026-11-18T05:55:20+01:00 No launch: workable nothing; 1 lap(s) active, 0 still choosing."
- obstacle parked godspeed-2.0.0-beta.27-sees-it-through#2 (since 2026-11-17T16:31:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.28-keeps-watch#2 (since 2026-11-17T16:31:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.28-keeps-watch#3 (since 2026-11-17T22:01:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.28-keeps-watch#4 (since 2026-11-17T20:01:00.000Z) -> diagnose with claude/sonnet
- obstacle parked godspeed-2.0.0-beta.28-keeps-watch#5 (since 2026-11-18T00:31:00.000Z) -> diagnose with claude/sonnet

