---
name: forge-plan-release
description: Plan a release when the owner says “plan release”, “plan a release”, or “plan the next release”, optionally followed by a project name.
---

# Plan a release

Extract only the optional project name from the owner's request. Run `godspeed-forge plan`, followed
by that project name when present. Relay every prompt and message exactly. Let the owner approve with
“yes”, stop with “no”, or describe a change in everyday product terms. Do not create issues or claim
that work started before the command reports approval.
