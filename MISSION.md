# Mission

<!--
  Owner: humans only. This file is on the protected list; the factory cannot edit it.
  Written 2026-11-14 from the approved 0.1.0 plan. The out-of-scope list is a proposal by Mission
  Control for the owner to strike or keep.
-->

**Derived from:** the release plan "The Forge 0.1.0: the Forge Process as a Godspeed add-on"
(approved by the owner on 2026-11-14; its items are restated in this repository's issues)
**Last reconciled with it:** 2026-11-14

## What the Forge is

An add-on for Godspeed Mission Control that gives a person who has Godspeed on a server and a
project on GitHub a whole development process. They say "set up the Forge for <repository>", and
from then on they plan a release in one sentence, Cole Medin's AI software factory builds it ticket
by ticket, the questions only they can answer reach their chat in plain words, a finished release
lands on their staging copy by itself, and their "go" makes it public ("take it back" returns the
public to the version before).

Built in: one owner per Godspeed install; the owner's own server, GitHub account, GitHub Apps and
coding-agent sign-in; Cole Medin's factory as the only thing that builds; Godspeed's own chat and
notice path as the only way the Forge talks to the owner.

## Who it is for

- A person who runs Godspeed on a server and maintains software on GitHub, and wants releases built
  and shipped without running the factory by hand or reading its machinery.

The Forge is not a coding agent and not a factory of its own: it sets up, feeds and finishes around
Cole Medin's factory.

## Core capabilities (in scope)

**Setting up**
- Installing Cole Medin's factory for a repository from his own repository at one pinned revision
  (and the Archon revision his installer pins), on the owner's Godspeed server.
- Guiding the owner through creating their own two GitHub Apps (one to build, one to release) on
  GitHub's own pages, and asking only what the software is for and who uses it.
- Finding which coding agent (Claude Code or Codex) is signed in and saying what a release will cost.

**Planning**
- "Plan release <project>": proposing one release from open reports, failing tests and what the last
  release left, with its cost, in plain words; on the owner's yes, filing its tickets for the factory.

**Questions**
- Bringing a decision the factory cannot make to the owner's chat once, in plain words, with an
  example and a short reply handle, and posting their reply back where the factory reads it.

**Finishing a release**
- Noticing that every ticket of an approved release is merged, freezing it, running its tests,
  putting it on staging, and sending one message: on staging, or which tests failed and why.
- On the owner's go, making it public; on "take it back", returning the public to the version before.

**Watching**
- A page on the owner's server, at an address of its own behind a sign-in, where they watch the factory at work:
  Archon's own pages, read-only, built from the same pinned Archon that setup installs.

**Project profiles**
- A plain profile that works for any project, and a way for a project to add its own steps (how it
  is installed, how its staging copy is updated) as settings beside it.

## Out of scope: the factory must never build this

**Other people's code**
- Carrying, copying or editing Cole Medin's factory or Archon inside this repository. They are
  installed from their own repositories at a pinned revision; moving the pin is a Forge release.
- A builder loop, review or AI workflow of the Forge's own beside Cole Medin's. All AI work runs
  through Archon's shared SDLC workflows.

**Going public**
- Making anything public, or changing what the public downloads, without the owner's explicit go.
- Posting, emailing or messaging anyone other than the owner.

**Keys and accounts**
- Storing an owner's keys, App credentials or tokens anywhere but their own server, or sending them
  anywhere.
- Creating GitHub Apps, accounts or AI subscriptions for the owner without their own click, or
  paying for anything on their behalf.
- Shipping any one person's settings in this repository: server names, keys, GitHub Apps, hidden
  scenarios or release records.

**Something else entirely**
- A hosted service: running the Forge for other people, or accounts on a Forge website.
- A project-management tool (boards, sprints, time tracking).

## Hard invariants: not tunable by any issue

1. **Nothing goes public without the owner's go.** A release waits on staging until the owner says
   go, and "take it back" always works on what was made public.
2. **Cole Medin's factory is installed, never carried or changed.** Everything the Forge adds sits
   beside it.
3. **Every setting has a default in one config file, and no file holds a secret.** Each owner's Apps
   and keys are made on their own machine and stay there.
4. **Tests spend no AI money.** Tests and proving scenarios run with a stand-in coding agent.
5. **The owner hears only decisions that are theirs,** once, in plain words, with one way to answer.
   Questions about how to build something never reach them.
6. **The factory cannot modify governance files.** `MISSION.md`, `FACTORY_RULES.md` and the
   conventions file are the constitution. A pull request touching any of them is an automatic reject.
7. **The factory cannot modify its own judge.** `harness/`, `.factory/` and the scenarios define
   what "working" means here. Adding an assertion is always welcome; removing or loosening one is a
   human decision, always.

## Allowed evolutions

- New project profiles and new steps inside the plain profile.
- Clearer messages to the owner, and more tests and scenarios.
- Supporting another coding agent that Cole Medin's factory supports.

## Definition of done

**Gate 1: tests pass.** `bash test/run.sh` ends with `N of N pass`.

**Gate 2: an owner can follow every message.** Any new message to the owner is plain words, names
what happened and what they can do, carries at most one link, and has no internal names.

**Gate 3: the journeys in `harness/END-TO-END.md` pass as a real owner would take them,** in a
throwaway container with the stand-in coding agent.

## Open questions: decisions nobody has made yet

These are undecided, not forbidden. **The factory may propose an answer to any of them**, build
against it, and record what it assumed; the merge is then held for a human.

- **Q1** Where on the Godspeed server the Forge keeps its config file and its state.
- **Q2** What a project without a running service gets as its staging copy beyond a GitHub
  pre-release.

**Except these, which do stop the factory:**

- Anything that deletes a release, a tag or a branch on the owner's repository.

## Decisions

- 2026-11-14 **Which GitHub permissions do the two Apps ask for?** A question of how, not the
  owner's: Mission Control decides it, on minimum privilege for each App (the build App only what
  building and opening pull requests in that one repository needs, the release App only what
  making an approved release public needs). The owner decides only what the software does for its
  users.
- 2026-11-14 **Which coding agent does the Forge use?** Whichever of Claude Code or Codex the owner
  already has signed in on that server; the setup says which one it found.

## What the factory does NOT own: permanently human

- Whether a message to the owner reads right and is worth their attention.
- Whether a cost estimate is believable.
- Whether a release is worth making public: the go is the owner's.
