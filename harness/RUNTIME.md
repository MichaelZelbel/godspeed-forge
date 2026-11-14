# How to run the Forge in a checkout

For every agent of the factory. The journeys to check are in `harness/END-TO-END.md`.

## The tests

`bash test/run.sh` from the root. Its last line is `N of N pass`. Save the whole output in
`$ARTIFACTS_DIR` (or a temporary folder when that is not set).

## The proving scenarios

Once they exist (the 0.1.0 tickets add them), each scenario is one script under `scenarios/`, named
after its journey, and `bash scenarios/run.sh` runs all of them and ends with `N of N pass`. They run
in a throwaway container with a fresh Godspeed, a tiny sample repository and the stand-in coding
agent. Several checkouts may run at once: never a fixed port, container name or folder outside the
checkout's own temporary folder.

Until a ticket adds them, there is no app to start: the tests are the whole check.

## What never to do on this machine

Never run the Forge's installer for real against a repository or a Godspeed install that is not
the throwaway one a scenario made, never sign a coding agent in or out, never create or change a
GitHub App, never push to a repository other than the one being built, and never use a real coding
agent in a test.
