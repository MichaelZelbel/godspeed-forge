---
release: godspeed-2.0.0-beta.26-keeps-its-word
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.26: keeps its word

Status: withdrawn (2026-11-15, about 19:30 UTC). Michael: "I see. Then please plan again after
Beta 25 is frozen and on my server. Then let's see what the next steps are." By then items 1 and 4
had merged in beta.25 (#612, #614) and item 2's code too (#655). The next plan is written fresh
after beta.25 is staged; this file stays as the record of the proposal.

The theme: four promises beta.25 made and could not finish in its round, finished, plus the
security update of the notebook's building blocks done again without breaking a restart.

## Why this release exists

Beta.25 was approved on 2026-11-15 at about 01:45 UTC. By 13:00 UTC three of its seven items had
merged (#573, #581, #611). The other four each reached the factory's cap of two send-backs, and
the decisions posted on #531 at 10:21 UTC did not free them: #583 was parked again at 10:33
because the loop does not read decisions on #531; #596's and #609's authorized laps ran and failed
(a path bug in four new tests; a scenario that calls a transcription function Hermes does not
have); #610's PR #614 kept its `needs-owner` label and no lap ran.

Separately, main turned red at 06:45 UTC with #617 (notebook UI dependency update, react-router
6 to 7 and zod 3 to 4): after a server restart the signed-in Import page sometimes renders an
empty document (#619). The nightly then had no image for main's head and its stage failed (#622,
28 scenario issues consolidated in #651). The integrated image check runs only after a push to
main, so #617 merged without it. Two investigation laps on #619 hunted the cause without
comparing versions. Mission Control did (2026-11-15, 13:00 to 13:45 UTC): with #617 the check
fails at the restart page in 3 of 5 runs; with #617 reverted, 3 of 3 pass; before #617, 29 of 29
first attempts passed on main. The revert is pull request #654 (tree identical to 9922403), with
an owner decision on #619 for the loop to review and land it. It belongs to beta.25: a candidate
with #617 would show some server users a blank page after a restart.

Beta.25's own rule is that an item reaching a dead end leaves the release and the rest ships. So
the proposal to Michael is: once #654 has merged, beta.25 ships with what merged (moving 01, 02,
04 and 06 out by `scope-amendment.json` with his words), and those four continue here.

## What it delivers (what changes for the person)

1. **Voice notes are understood without a paid key, in the language spoken.** (#609, continuing
   PR #612.) Full.
2. **A chat that is already open notices within about five seconds when an AI is connected or
   stops working**, without a reload. (#583, the part PR #601 left.) Light.
3. **"Today's briefing" asked in any chat is the saved briefing**, with the same next step and
   Charm Challenge line. (#596, continuing PR #605.) Light. Its holdouts need the browser verifier
   from #620 (below).
4. **A large picture or PDF that stayed on one computer appears in the other computer's Media
   Library**, findable by name, with the explanation of where the original is. Opening it directly
   already explains itself on PR #614. (#610, continuing PR #614.) Full.
5. **The notebook's building blocks get their security fixes again, and a restart keeps working.**
   The 26 vulnerability records #617 removed come back with the revert; this redoes the removal and
   proves it with the integrated image check (install, restart, signed-in pages) on the branch
   before merging. New issue. Light.

## How each is decided (questions of how, decided here, not Michael's)

- Item 1: the seam is Hermes's own public function `tools.transcription_tools.transcribe_audio`,
  reading the installed config (`stt.provider: local`, or unset so Hermes picks local), the same
  call a Telegram voice note makes; the product's dictation keeps
  `transcribe_audio_local_fallback`, which `notebook/assistant-files/dictate.py` already uses.
  PR #612's scenario looks for `transcribe_local` or `_transcribe_local` in
  `tools.transcription_local`, a helper module that holds only settings and model-loading helpers;
  Hermes's transcription functions are in `tools.transcription_tools` (checked against upstream
  Hermes on 2026-11-15), which is why it fails. Never probe private names. The installed permission and no-permission journey stays part of acceptance.
- Item 2: every open chat refreshes its AI state on its own within about 5 seconds, no reload or
  focus needed; the same window item 3 of beta.25 accepted (posted on #531, 2026-11-15 10:21).
- Item 3: the four new verifier tests must resolve `notebook/scripts/...` from their own file's
  location, not the working directory (they ran from `notebook/` and looked in
  `notebook/notebook/scripts`). The acceptance stays exactly as written.
- Item 4: the requirement stands as written: a searchable Media Library card on the other
  computer, with the kept-elsewhere explanation (posted on #531, 2026-11-15 10:21).
- Item 5: major-version upgrades (react-router 7, zod 4) only if the integrated check passes on
  the branch, restart included; otherwise fixed versions within the current majors, or removal of
  unused packages, are enough. No vulnerability record of high or critical severity may remain.

## What it does not do

- Contract switching (#379), one home for everything (#90), weak checks on daily work (#279), the
  coach add-on copy against its pin (#299), the owner's private approval gate (#413): each still
  needs Michael's answer or a design.
- The known issues (#1, #2, #7).
- The verification routes #616 and #620 are not items: the loop is already building them under the
  partition decided on #531 at 10:22, and they ship with whichever release follows their merge.

## How it is built

Cole Medin's factory on the AX41, as beta.25. Items 1 to 4 keep their issues and pull requests,
relabelled from `beta.25` to `beta.26`, each with its owner decision posted on the issue itself
(the loop reads the item, not #531) and `needs-owner` removed from issue and pull request. Item 5
gets a new issue. Caps: three attempts or two send-backs per item, then `needs-owner`; an item that
reaches a dead end leaves the release, the rest ships.

## Proving

- Every pull request: `required` and Cole's app check against `harness/END-TO-END.md`; item 5 also
  a passing run of `Integrated Godspeed v2` on its exact head.
- The release step: the nightly proving scenarios on the candidate.

**Blocking scenarios:**

- a voice note, with the permission and without it (item 1, with the fresh native install with no
  key and the German voice note)
- a picture added on one computer shows in the same note on a fresh install from the GitHub copy
  (`media-travels`, item 4, with a file over 50 MB)
- today's brief asked in the chat is the morning briefing (item 3)
- the fresh installed server and browser check, restart included (item 5)
- 9 hidden scenarios in godspeed-holdouts (H-19..H-26, H-29; item 2), 5 (H-09..H-13; item 4) and 4
  (H-04..H-06, H-18; item 3)

Every other failing job is named with its cause and does not block (standing rule of 8 November
2026).

## Cost estimate

No ledger measures the factory yet. Four items are open pull requests needing one or two more laps,
one is a small dependency change: about 4 to 6 percent of a week of the ChatGPT plan, where the
factory builds since 14 November (D-415), plus a small Claude share for planning and the release
step. The scenario AI runs on OpenRouter as before.

## After go

- Guide pages: voice notes (item 1), Your AI and the chats (item 2), the morning brief in chat
  (item 3), where pictures and PDFs are kept (item 4).
