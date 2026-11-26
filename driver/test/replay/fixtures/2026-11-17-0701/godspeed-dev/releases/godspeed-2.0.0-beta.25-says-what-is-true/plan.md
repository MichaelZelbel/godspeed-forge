---
release: godspeed-2.0.0-beta.25-says-what-is-true
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.25: says what is true

Status: approved by Michael on 2026-11-15 ("Yes, please start."). Proposed the same day ("Plan beta release Godspeed").

The theme: Godspeed tells the person the truth about its own state. A chat says whether an AI is
really there before they type, a voice note is understood as Settings promises, the briefing reads
the same everywhere, and a file that stayed on one computer says so instead of looking broken.
Every item is a bug on main today or the maintainer's own finding; no new features beyond his own
request #581.

## Already merged since beta.24 (ships with it, no work left)

18 pull requests on main since product commit 901a784: Telegram short replies follow one language
decision (#516); one sync conflict holds back only its own file (#578); "Sync now" with nothing
connected says so (#580); files over 100 MB get a plain explanation (#603); Settings reopens with the
saved AI connection (#598); chat model labels stay readable in narrow composers (#606); a
collection's chat in its own window is the same conversation (#589); filtered briefings lose their
empty bullets (#599); moments saved without AI make no failing request (#604); the People picker
stays above the dialog buttons (#597); Settings explains when no assistant program is installed
(#607); first-day and work-run fixes (#560, #575); the notebook web page's tests and type check run
in CI (#574, #608); guide map pages (#577); hidden scenarios outside the repository (#591); mission
delegates ordinary product choices to the manager (#602).

## What it delivers (what changes for the person)

1. **Voice notes are understood without a paid key, in the language spoken.** (#609, the
   maintainer's finding on his server, 2026-11-15.) A native Linux install (and Windows, if it has
   the same gap) installs the local transcriber the way the Docker candidate already does, so the
   Settings promise is true; Godspeed leaves the transcription language blank (auto-detect) on
   install and when it switches transcription on, so a German voice note comes back in German, with
   or without ElevenLabs. Full.
2. **Every chat says, before you type, whether an AI is connected and usable**, and points to
   Settings, Your AI when it is not. (#583, PR #601.) Decided (#531, 2026-11-15): the status check gets
   its own short request budget in the provider contract. Light (continuing).
3. **The AI's state is honest everywhere else too.** Model pickers name the connected model, a
   refused key or a stopped AI no longer shows "Ready to chat", and a note's "AI" button says what it
   does (hide the note from AI). (#573, PR #579.) Decision of how, taken here: the shown state may lag
   the real one by about five seconds and corrects itself without a reload; reviewers measured that
   and called it normal, so the merge gate accepts it. Light (continuing). Items 2 and 3 together
   close holdouts H-19..H-26 and H-29 (#590).
4. **"Today's briefing" asked in any chat is the saved briefing**, with the same next step and
   Charm Challenge line, never a substitute. (#596, PR #605.) Light (continuing).
5. **Adding a moment by hand can add a new person**, also when People is still empty. (#581, the
   maintainer's request, PR #582.) Decision of how, taken here: Enter on a partly typed name picks
   the existing person; a new person is made only by choosing "Add ... as a new person" (or Enter
   when nobody matches), so no accidental duplicates. Light (continuing).
6. **A large picture or PDF that stays on one computer explains itself on the other.** A file over
   the 50 MB travelling limit shows a deliberate placeholder on every media surface of the other
   computer, saying the original is on the first computer and what to do, never a broken image or a
   bare error. (#610, holdouts H-09..H-13.) Full.
7. **The two-computer reminders proof stops tripping over GitHub's request limit.** "Two computers
   that move the same reminders at once" failed on the beta.24 candidate and the 14 November nightly
   only because GitHub's anonymous limit (60 calls an hour) answered its privacy check with 403. The
   check uses an authenticated request (or a cached answer) in the scenario so it judges Godspeed,
   not GitHub's rate limit; the product behaviour and the bar it is judged by stay the same. Light.

## What it does not do

- Contract switching (#379), one home for everything (#90), weak checks on daily work (#279), the
  coach add-on copy against its pin (#299), moving the owner's private approval gate into Godspeed
  (#413): each still needs Michael's answer or a design.
- The known issues (#1, #2, #7).
- The factory's Telegram questions (#600): the relay and its reply parser live in Mission Control's
  own machinery, not in the product (the loop confirmed this on 2026-11-14); the governance half
  merged as #602. Fixed there, outside this release.

## How it is built

Cole Medin's factory on the AX41, as beta.24: each item its existing issue (item 7 gets a new one),
labelled `beta.25`; everything else `needs-owner` while the laps run. Items 2 to 5 continue their
open pull requests and need only the decisions above posted as `Owner decision` comments on #531
and the items. Item 1 is already claimed by the loop. Items 1 and 6 are full, the rest light. No two
items share files except 2 and 3 (both touch the chat panels): 3 merges first, 2 rebases. Merging:
the reviewer's verdict for the exact head plus the green `required` check. Caps: three attempts or
two send-backs per item, then `needs-owner`; an item that reaches a dead end leaves the release, the
rest ships.

## Owner decision for item 7

The privacy check may use an authenticated GitHub request or a cached answer inside the scenario.
Approved changes to what the scenario judges: none looser. It must still fail when the notebook copy
is public or the check is skipped.

## Proving

- Every pull request: `required` and Cole's app check against `harness/END-TO-END.md`.
- The release step: the nightly proving scenarios on the candidate.

**Blocking scenarios:**

- a voice note, with the permission and without it (item 1; extended with a fresh native install
  with no key, and a German voice note)
- a picture added on one computer shows in the same note on a fresh install from the GitHub copy
  (`media-travels`, item 6, extended with a file over 50 MB)
- two computers that move the same reminders at once (item 7)
- today's brief asked in the chat is the morning briefing (item 4)
- 9 hidden scenarios in godspeed-holdouts (H-19..H-26, H-29; items 2 and 3) and 5 (H-09..H-13; item 6)

Every other failing job is named with its cause and does not block (standing rule of 8 November
2026).

## Cost estimate

Beta.24 was estimated at 8 to 12 percent of a week's Claude allowance for six items; it has no cost
ledger. Here four of seven items are finished pull requests that need a decision and a last round,
one is a scenario fix, two are real work (voice transcriber on native installs, the media
placeholder): about 5 to 8 percent of a week's allowance. Correction after the yes: since 14 November
(D-415) the factory builds on Codex with Michael's ChatGPT plan, not on Claude, so this share falls on
the ChatGPT plan's weekly allowance; the planning and release step stay on Claude (small). The
scenario AI runs on OpenRouter as before.

## Started (2026-11-15, about 01:45 UTC)

- Issues: item 1 #609, 2 #583, 3 #573, 4 #596, 5 #581, 6 #610, 7 #611
- Each labelled `beta.25`, its ticket posted as a comment (#611 was filed with the ticket as its
  body); `needs-owner` removed from #573 and #581 and from pull request #605. Every other open issue
  carries `needs-owner` (#590 added: it closes when items 2 and 3 land); #531 and #509 are the
  manager's own lists and stay as they are.
- Owner decisions posted on #531 for questions 1 (#573, the five-second window) and 2 (#581, Enter
  picks the existing match), as decided above. Adding them to the Telegram helper's
  `answered-elsewhere.json` was refused by the session's permission check; not needed, the manager
  drops answered questions from #531 at its next pass and a vanished question is never mentioned.
- #569 closed as done (merged as #608; notebook-ui green on main 2026-11-15 01:25 UTC).
- No unit to start: Cole's scheduler on the AX41 picks the labelled issues within minutes (#609
  was already claimed by a lap). `auto-stage.timer` stages the release once all seven issues are
  closed by merged pull requests.

## After go

- Guide pages: voice notes (item 1), Your AI and the chats (items 2, 3), the morning brief in chat
  (item 4), timeline moments (item 5), where pictures and PDFs are kept (item 6).
