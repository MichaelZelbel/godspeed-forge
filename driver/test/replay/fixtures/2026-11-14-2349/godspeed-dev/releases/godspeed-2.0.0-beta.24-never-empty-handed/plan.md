---
release: godspeed-2.0.0-beta.24-never-empty-handed
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.24: never empty-handed

Status: approved by Michael on 2026-11-13 ("Yes, please start it and let our Forge processin in Archon run as parallel as possible"). Proposed the same day; he asked for it
public, and at the same time let's plan Beta 24."

The theme: where Godspeed's own safety checks refuse something the AI wrote, the person still gets
the talk or the brief, and the pictures and PDFs in their notes are never left behind on one
computer. Every item is something that went wrong for real in the last two days.

## What it delivers (what changes for the person)

1. **A coaching talk always starts.** When the AI's first reply misses the prepared opening (or the
   honest "the preparation is not ready" sentence), Godspeed asks it once more with the reason, and
   if it misses again, opens the talk from the prepared record itself. Never an error instead of a
   talk; the guard still never lets a wrong opening through. (#489; found by the beta.23 candidate
   run, waived by Michael for that release only.)
2. **The morning brief always arrives.** Last night's check on the main line: the AI's brief said
   "nothing from the calendar needs attention" without having read the calendar, the source check
   refused that sentence, and the checked fallback then refused too, so no brief was written at all.
   A sentence the source check refuses is dropped (or replaced by what the sources do say), and the
   brief is saved with what passed. A brief with no passing sentence still arrives as the honest
   short note the fallback already writes. (#491, scenario "a briefing that breaks a rule still
   arrives".)
3. **Pictures and PDFs travel with the notebook.** Michael's own finding on 13 November: his server's
   media library showed no images or PDFs, because the move to the new server carried the
   notebook's records of 43 files but not the files, and nothing in Godspeed could bring them back
   (Mission Control restored 41 by hand from the laptop and the old server's safety copy; 2 saved
   web pages from May are gone). Decision on #57 (the "how" is ours, per plan-release): option 1,
   media goes into the private GitHub copy beside the notes, as plain files under the notebook,
   named by content so a file added twice is stored once. Reasons: it is the only option that works
   with no server and no pairing, a fresh install or a new server gets every file from the copy it
   already clones, and it is what Obsidian users already know. Limits: a single file over 50 MB is
   not committed (GitHub refuses 100 MB) and stays in the nightly backup, and the media library says
   so on that file. Existing installs: on the first run after the update, the media already on the
   computer is added to the copy once. Server-and-computer media sync (`notebook/core/sync/media.mjs`)
   stays as it is for now and simply finds the files already present. (#57)
4. **The first day's work finishes.** In last night's check, the routine "Daily round: do the work"
   on a fresh Docker server did not finish within 30 minutes. Find why; if Godspeed hangs or waits on
   something, fix it so the first day's work completes or says why it stopped; if the check's time
   limit or its AI is the cause, fix the check. (#492)
5. **English replies on Telegram stay English.** A short translated reply can still carry one or two
   German words ("I saved the Eintrag"). Decision on #486 (owner left it open on #453): for a reply of
   under 25 words, any word on the other language's list that is not a known loanword (Login, API,
   Tests and the like) makes the reply be translated once more; longer replies keep the share rule.
   (#486)
6. **The proof of updating works again.** The scenario "an update from the current public version
   keeps everything" now fails because its stand-in newer release carries the same version the
   install already has ("You have the newest version, 2.0.0-beta.23"). The stand-in must always be
   newer than whatever the install runs, including right after a release step. (#490)

## What it does not do

- Contract switching (#379), one home for everything (#90), weak checks on daily work (#279), the
  coach add-on copy against its pin (#299, coach repository), moving the owner's private approval
  gate into Godspeed (#413): each still needs Michael's answer or a design.
- The known issues (#1, #2, #7).
- Pairing two Windows computers directly for media: item 3 makes it unnecessary.

## How it is built

Cole Medin's factory on the AX41, as beta.23: each item its existing issue, labelled `beta.24`;
everything else `needs-owner` while the laps run. Items 1, 2, 5 and 6 are light; item 4 starts
with finding the cause and is full; item 3 is full (installer, notebook save path, first-run
migration, media library notice). All six can run at once: no two touch the same files except 1 and
2, which share nothing but the idea. Merging as beta.23: the reviewer's verdict for the exact head
plus the green `required` check. Caps: three attempts or two send-backs per item, then
`needs-owner`; cutting instead of blocking as in beta.22 (an item that reaches a dead end leaves the
release, the rest ships).

## Proving

- Every pull request: `required` and Cole's app check against `harness/END-TO-END.md`.
- The release step: the nightly proving scenarios on the candidate.

**Blocking scenarios:**

- a talk says when its preparation did not pass, and opens from one that did (item 1)
- a briefing that breaks a rule still arrives (item 2)
- a fresh Docker server turns a first goal into useful work (item 4)
- Telegram answers in the language of the message (item 5)
- an update from the current public version keeps everything (item 6)

Item 3 adds a scenario, "a picture added on one computer shows in the same note on a fresh install
from the GitHub copy", which becomes blocking once it exists. Every other failing job is named with
its cause and does not block (standing rule of 8 November 2026).

## Cost estimate

Beta.23 (16 items, several large) cost about 17 percent of a week's Claude allowance in the
factory. Six items, one of them a real design (item 3) and one an open investigation (item 4):
about 8 to 12 percent. Nothing on OpenAI; the scenario AI runs on OpenRouter as before.

## After go

- Guide pages: coaching talks (item 1), the morning brief (item 2), a section on where pictures and
  PDFs are kept and that they reach every computer (item 3), the Telegram page (item 5).

## Started (2026-11-13 12:47 UTC)

- Unit `godspeed-forge-beta24`, 6 laps at once (one per item; the maintainer asked for as parallel
  as possible, and a seventh or eighth slot would only find nothing free), at most 60 laps; log
  `/var/log/godspeed-forge/beta.24.log`. No cut-off timer.
- Issues: item 1 #489, 2 #491, 3 #57, 4 #492, 5 #486, 6 #490, each labelled `beta.24` with its
  ticket posted as a comment; every other open issue carries `needs-owner`. No chains.
- The scenario for item 3 needs a workflow job under `.github/`, which the factory cannot touch:
  Mission Control adds it by hand once item 3's pull request says what it should do.
- First run ended 14:28 UTC after 9 laps: items 1, 2, 3, 5 merged (PRs #493, #497, #499, #494).
  Items 4 (PR #498) and 6 (PR #496) parked for an owner decision on a changed scenario judge;
  Mission Control approved both (how-questions delegated by this plan) and restarted the runner at
  15:29 UTC as `godspeed-forge-beta24b`, 2 laps at once.

## Release step (2026-11-14)

- The version and the cross-install scenario for item 3 (`media-travels`, a job in `scenarios.yml`, its tests, in the verdict) went in as pull request #568 (opened with the owner's login because the builder App has no workflows permission, approved and merged by the release App as 901a784). The scenario passed on its own run against real code before the freeze.
- Frozen as `candidate/2.0.0-beta.24` (commit 104dd6b on top of product commit 901a784), put on the server at 13:39 UTC, healthy, add-ons reach the AI.
- Scenarios on the tag (run 43600813210): every blocking one and `media-travels` passed. Two failed outside the blocking list: "two computers that move the same reminders at once" (GitHub's own rate limit of 60 calls an hour answered its live privacy check with 403) and "the Charm Challenge, start to finish" (the check that compares the Trackers card with the chat got an empty chat answer). Both are named causes under the waiver of 8 November 2026, so Michael is asked with them; nothing was sent to him by the check.
- The factory was paused with `.factory/STOP` from 13:44 UTC until the scenarios ended, to save the scenario key; removed at about 14:10 UTC.
