# Factory operations

This application runs on a pinned Archon SDLC source. See
[factory/MIGRATION.md](factory/MIGRATION.md) for installing and upgrading it.

Shared workflow gates own every decision. Inspect a run's identity and status
before responding to a declared gate.

Project runtime scenarios: `harness/END-TO-END.md`.
Holdout scenarios: none in this repository. This factory runs on Codex, and Cole Medin's README
says: "The fence is a Claude Code hook. A factory running Codex or Pi has no fence: keep its holdout
outside the repository and pass that path as the `holdout` input instead." Any hidden scenario for
the Forge therefore lives only on the machine that runs its factory and reaches the loop and the
manager as their `holdout` input; `.factory/holdout/HOLDOUT.md` stays the empty template.
The schedule (`.factory/schedule.json`) is that machine's own setting and is not committed.
Ordinary checks: `bash test/run.sh` (also `python harness/ci.py`, which runs the same).

Record this application's tested source SHA, candidate, run IDs, coverage,
fresh-environment evidence and open integration limits here after testing.

## Open integration limits (2026-11-14, set up by hand)

- The local coding-agent and GitHub stand-ins and all three proving scenario specifications exist.
  `bash scenarios/run.sh` currently fails at each named missing product step because the installer,
  release path and question relay have not landed yet.
