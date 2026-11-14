See [factory workflow policy](factory/WORKFLOW_POLICY.md) for factory-specific shared-workflow requirements.

# How the Forge is built

- **Tests:** `bash test/run.sh` runs every `test/*.test.sh` (bash) and `test/*.test.mjs` (node) and
  ends with `N of N pass`. A change comes with the tests that prove it. The `required` check runs the
  same command.
- **No AI money in tests.** A test or scenario that needs a coding agent uses the stand-in agent,
  never a real one, and never needs a key.
- **Cole Medin's factory and Archon are never in this repository.** The Forge installs them from their
  own repositories at the pinned revision; nothing here copies or edits their files. The factory files
  in `factory/`, `harness/` and `.factory/` are what his installer wrote for this repository's own
  development and are not part of what the Forge installs for others.
- **No one's private settings in files:** no server names, keys, tokens, GitHub App ids or hidden
  scenarios. Every setting has a default in one config file; per-owner values are made on the owner's
  machine and stay there.
- **Messages to the owner** are plain English: what happened, what they can do, at most one link, no
  internal names, no jargon. A message is tested by its exact text.
- **Shell:** bash scripts start with `set -eu`, quote every variable, and run on a stock Ubuntu with
  `git`, `gh`, `node` 22, `python3`, `bun` and `uv`.
- **Commits** say in plain words what changed and why.
