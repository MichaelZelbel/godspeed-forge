---
name: forge-plan-release
description: Plan a release when the owner says “plan release <project>”, “plan the next <project> release”, or “what should go into the next <project> version?”, with the project optional.
---

# Plan a release

Recognize “plan release <project>”, “plan the next <project> release”, and “what should go into the next <project> version?”. Extract only the optional project name from the owner's request. Run `godspeed-forge plan`, followed
by that project name when present. Relay every prompt and message exactly. Let the owner approve with
“yes”, stop with “no”, or describe a change in everyday product terms. Do not create issues or claim
that work started before the command reports approval.
