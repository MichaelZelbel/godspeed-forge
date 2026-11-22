Ticket for 2.0.0-beta.28 (plan item 1). Size: light. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #299.

## Problem

`python3 notebook/scripts/vendor-addons.py --check` reports differences in `third-party/addons/godspeed-coach` against its pin b134abff in `third-party/addons/sources.json`: the carried copy was changed inside the product (#185, #190, #224, #319, #407, #461, #495/#512) without those changes going into godspeed-coach and being re-pinned. The copy also has files the pin lacks (lib/prep-receipts.mjs, lib/questions.mjs, lib/rhythm-change.mjs and their tests).

## Why

The add-on's own repository is the source of truth for what the coach is. While the copy and its pin disagree, re-vendoring the coach from its repository would silently drop every one of those fixes.

## Why now

Mission Control has already moved the carried copy's exact content into godspeed-coach: commit `7d25fb0db5d57f8db82f79f4392b093267c17015` on its main (17 November 2026). A byte comparison of that commit against the copy on main found zero differences across 56 files. Only the re-pin is left.

## Outcome

`third-party/addons/sources.json` pins godspeed-coach to `7d25fb0db5d57f8db82f79f4392b093267c17015`, its file list names every file the copy carries (including the three new lib files and their tests), the copy is brought back with `vendor-addons.py` from that commit, and `vendor-addons.py --check` passes for every add-on.

## Invariants

- The carried coach's content does not change: re-vendoring from 7d25fb0 must produce the same bytes as the copy on main today. If it does not, stop and report the difference instead of editing the copy by hand.
- The other add-ons and their pins are untouched.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- `vendor-addons.py --check`, with every add-on checked out at its pin, reports no difference for any add-on.
- Repository tests and the integrated check pass.
- Known limit, not part of this ticket: the coach's `test/prep.test.mjs` sets `GIT_CONFIG_GLOBAL` to `os.devNull`, which git rejects on Windows; it passes on Linux CI.

## Done means

The pin and file list are updated, the copy is re-vendored from 7d25fb0, and the check passes in the builder's copy.
