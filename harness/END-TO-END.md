# Journeys

What an owner does with the Forge. The repository holds only its plan so far, so these describe the
behaviour the 0.1.0 release builds (Cole Medin's README: a product document is the one place that
describes behaviour before the code exists). Each runs in a throwaway container with a fresh
Godspeed, a tiny sample repository and the stand-in coding agent, so no AI money is spent. The
proving scenarios of the same names (`scenarios/`) are the scripted form of each.

## An owner sets up the Forge for a small project (forge-setup)

1. On a fresh Godspeed server, the owner says "set up the Forge for <sample repository>".
2. The Forge installs Cole Medin's factory into that repository's checkout at the pinned revision,
   says which coding agent it found signed in, and what a release costs on it.
3. It shows the two GitHub App pages to click (one to build, one to release) and asks only what the
   software is for and who uses it.
4. Afterwards the factory's own check (`python factory/consumer.py doctor`) passes in that checkout,
   the repository has a mission file with the owner's two answers in it, and the Forge's config file
   holds every setting with no key or token in it.

**What would make this fail:** a factory file that differs from Cole Medin's at the pin, a key or
token written into the repository or the config file, a question beyond the two, or a setup that
reports success while the factory's own check fails.

## One release goes from plan to public and back (forge-one-release)

1. The owner says "plan release <sample project>". The Forge proposes one release in plain words
   with its cost; the owner says yes, and its one ticket is filed as an issue.
2. The stand-in coding agent builds it and its pull request merges.
3. The Forge notices the release is complete, freezes it, runs its tests, puts it on staging and
   sends exactly one message: it is on staging, shall it make it public?
4. The owner says go. The public version is now the release.
5. The owner says take it back. The public version is the one before again.

**What would make this fail:** a second "on staging" message for the same release, anything public
before the go, a go that changes nothing, or a take-back that leaves the new version public.

## A factory question reaches the owner once and the answer lands (forge-questions)

1. The factory asks the owner a decision on its questions issue.
2. Within one pass, the owner's chat gets one message in plain words with an example, the choices
   and a short reply handle.
3. The owner replies with the handle and a choice.
4. The reply appears once on the questions issue, as an owner decision with the owner's words.

**What would make this fail:** the same question sent twice, a message with internal names in it, a
reply posted twice or to the wrong question, or a question about how to build something reaching
the owner at all.
