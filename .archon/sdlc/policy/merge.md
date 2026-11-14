# Merge queue policy: the Forge

This adds to the SDLC pack's default merge policy.

## A pull request of an approved release is merged without asking

The maintainer hears only decisions that are his. Making a release public is his own go, decided
in godspeed-dev and unchanged by this section. Merging a pull request that belongs to a release he
has already approved is not a new decision, and the queue does not ask it.

- A pull request whose linked issue's body names a release directory
  `releases/godspeed-forge-<version>-<slug>` whose plan is approved is merged without asking once
  the default's gate and its "Before a merge" rules are met. Its size label does not matter.
- To decide it, take the default's "Unclear" reasons that apply to the pull request and set aside
  exactly two: "Large changes", and "Partial work" for being one part of that release's plan. If no
  reason is left, the pull request is `clear`. If any reason is left, the queue asks, as the default
  says.
- Every other pull request keeps the pack's default.
- Reason: the same rule the Godspeed product has carried since 2 November 2026, when two pull
  requests of an approved release sat unmerged for hours because the queue asked about each.
