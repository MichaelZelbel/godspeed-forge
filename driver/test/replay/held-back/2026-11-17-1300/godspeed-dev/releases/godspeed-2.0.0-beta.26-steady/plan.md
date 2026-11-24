---
release: godspeed-2.0.0-beta.26-steady
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.26: steady

Status: approved by Michael on 2026-11-16 (""go" for beta 25, and "yes" for beta 26, with keep for
the Hostinger button."). Proposed the same day. Michael on 2026-11-15: "Then please plan again after Beta 25 is
frozen and on my server. Then let's see what the next steps are." Beta.25 was frozen from
75b61fe and installed on his server on 2026-11-16 at 07:03 UTC, healthy. Its two failing
scenarios are test-setup faults, not product defects (below). This plan is written fresh; the
withdrawn draft `godspeed-2.0.0-beta.26-keeps-its-word` stays as a record.

The theme: Godspeed stays steady and says what is true. A restart answers at once, a chat tells
the truth about the AI, the screens stop promising what the code no longer does, the security
fixes come back without breaking anything, and a buyer of the one-click server gets the version
everyone else has. Every item is a bug on main, a finding of the maintainer's, or work the last
round left; there are no new features.

## Already on main since beta.25 (ships with it)

- #676: the headache recipe text #668 shipped is registered, so main's integrated check passes.

## What it delivers (what changes for the person)

1. **Right after a restart the server answers at once** instead of showing "Let's reconnect" for
   a while. (#679) Full.
2. **A chat says plainly when the AI key was refused**, instead of calling it an outage. (#590,
   continuing pull request #660; the AI-state work beta.25 moved out, its items 2 and 3.) Full.
3. **A chat never briefly shows the AI as ready right after its connection failed.** (#667,
   continuing pull request #671.) Light.
4. **A Timeline moment can be linked to a person who already exists.** (#669, continuing pull
   request #672.) Light.
5. **The screens and the starter files stop promising what Godspeed no longer does**: deadline
   reminders beside the morning brief, pictures in the GitHub copy, the book's ready-made skills
   from the public line. (#664, the maintainer's own finding.) Light.
6. **The notebook's building blocks get their security fixes again, and a restart keeps
   working.** (New issue; #617 did this and was reverted by #654 because a restart then
   sometimes showed an empty page.) Light.
7. **A coaching talk prepared on an installed Godspeed comes out ready to use**, not as a draft.
   (#670; Michael moved it out of beta.25 into a later release.) Full.
8. **The Hostinger one-click button installs the current public version and follows every
   release by itself.** (#663, the maintainer's own finding.) Light. Michael keeps the button
   (2026-11-16: "keep for the Hostinger button").
9. **The Hevy scenario stops finding its own test key** in another scenario's file. (New issue.)
   Light.
10. **The waiting-steps test no longer fails when two steps fall in the same millisecond.** (#680)
    Light.

Issues: item 1 #679, 2 #590, 3 #667, 4 #669, 5 #664, 6 #615, 7 #670, 8 #663, 9 #685, 10 #680

## Michael's answers (what it does for users)

- Item 8: keep the Hostinger one-click button, always installing the newest public version
  (answered 2026-11-16).

## How each is decided (questions of how, decided here, not Michael's)

- **Item 1:** first measure what the server does in its first seconds after `docker restart`
  (index rebuild, store verify, Git, the add-ons) and why `/api/query` misses the sign-in gate's
  15 seconds. Then make the first answer come promptly. If startup work must run first, the gate
  shows that the server is starting and waits for readiness instead of failing. The fresh-server
  check's assertions stay exactly as they are.
- **Item 2:** PR #660's split stays: a refused key (401/403 from the provider) is said as a
  refused key with what to do, while an outage (timeout, 5xx, no route) is said as an outage. The
  holdouts H-19..H-26 and H-29 judge it, unchanged.
- **Item 3:** a failed in-flight health check wins over any cached ready value for every reader
  that overlaps it (PR #671's approach). No visible "ready" after a failure until a newer check
  passes.
- **Item 5:** only texts in this repository: `notebook/core/starting-routines.mjs` (the deadline
  reminders' and daily round's descriptions), `starter-godspeed/procedures.md`,
  `notebook/ui/src/local/RecordSync.tsx` (pictures and PDFs up to 50 MB are in the GitHub copy),
  and `starter-godspeed/AGENTS.md` (the book's skills from the public `beta` line, not `main`).
  The issue's unverified note about `memory-daily.mjs` gets one test. If that test shows the code
  overwrites a value the person typed, it is fixed to match the guide, which says such a value is
  never overwritten. The guide pages go in "After go".
- **Item 6:** fixed versions within the current majors, or removal of unused packages, first.
  React-router 7 and zod 4 only if the integrated check, restart included, passes on the branch.
  Since product PR #678 that check runs on every pull request anyway. No vulnerability record of
  high or critical severity may remain. The 26 records #617 removed are the list.
- **Item 7:** the installed `Coaching talk preparation` routine must produce `STATE: ready` for
  the supported clean fixture through its visible selector and Run now. The preparation-quality
  requirements and every holdout check (H-14..H-17) stay unchanged.
- **Item 8:** `docker/hostinger/one-click.yaml` is generated by
  `docker/hostinger/installer/public-compose.mjs` from the image digest of the version the public
  line serves, never edited by hand. A check fails when the file on the public line names another
  image than the released one. The release step's promote regenerates it on `beta` (godspeed-dev,
  Mission Control's part), and the website's purchase link points at the file on `beta` instead of
  a fixed commit ("After go").
- **Item 9:** `scenarios/notebook-assistant-browser.mjs` holds the made-up key `refused-scenario-
  key` literally. The native install carries the scenarios folder, so `workouts-from-hevy.sh`'s
  scan of the install finds it. The browser scenario gets its own made-up key, written split the
  way `workouts-from-hevy.sh` writes its own. What the Hevy scan judges does not change.
- **Item 10:** the test gets a deterministic clock, or `heard` orders by recorded position; the
  assertion (a question is answerable only after its words were delivered) stays.
- **#596 (the saved briefing through chat, H-18):** the product returns the saved briefing byte
  for byte (the loop measured it on 2026-11-16). What fails is the verifier's fixture, which
  consumes H-04's replies during H-18's plan because a generic partial match comes first. Decision
  for #596: keep it open, and make the fixture give H-18 its own draft, matched exactly, with the
  request, response and note retained. This is verification work, not a plan item; it goes with
  the verification routes (#616/#618, #652), which ship with whichever release follows their merge.

## What it does not do

- Contract switching (#379), one home for everything (#90), weak checks on daily work (#279), the
  coach add-on copy against its pin (#299), the owner's private approval gate (#413): each still
  needs Michael's answer or a design.
- The known issues (#1, #2, #7).
- The factory's Telegram questions (#600): Mission Control's machinery, outside the product.

## How it is built

Cole Medin's factory on the AX41. Items 2, 3, 4, 5 and 7 keep their issues; items 2, 3 and 4
continue their open pull requests. Item 6 continues #615 (reopened by the manager on 2026-11-16) and item 9 got a new issue. Each issue gets its ticket text as
an `Owner decision` comment (the loop reads the item) and the label `beta.26`, and `needs-owner`
comes off it and its pull request. Everything else stays `needs-owner`. Caps: three attempts or
two send-backs per item, then `needs-owner`; an item that reaches a dead end leaves the release,
the rest ships.

Since 2026-11-16 (D-420): every pull request runs the integrated tests before it can merge (product
PR #678), and a main that still breaks is taken back out by `keep-main-green`.

## Proving

- Every pull request: `required`, which now waits for "Integrated Godspeed v2", and Cole's app
  check against `harness/END-TO-END.md`.
- The release step: the proving scenarios on the candidate.

**Blocking scenarios:**

- the fresh installed server and browser check, restart included (items 1, 6)
- Docker and Linux import made-up Hevy workouts (item 9)
- two computers that move the same reminders at once (its token arrives with product PR #681)
- a talk says when its preparation did not pass, and opens from one that did (item 7)
- hidden scenarios in godspeed-holdouts: H-19..H-26 and H-29 (items 2, 3), H-14..H-17 (item 7),
  H-32 (item 4)

Every other failing job is named with its cause and does not block (standing rule of 8 November
2026).

## Cost estimate

No ledger measures the factory yet. Three items continue open pull requests, five are small, two
need investigation (1 and 7): about 6 to 9 percent of a week of the ChatGPT plan the factory builds
on since 14 November (D-415), plus a small Claude share for planning and the release step. The
scenario AI runs on OpenRouter as before.

## After go

- Guide pages: `deadlines.md` (reminders speak beside the brief), `routines.md` and
  `daily-work.md` (when the daily connection check starts), `clerk.md` (v0.5.2), `memory.md` (if
  item 5's test changes anything), "Your AI and the chats" (items 2, 3), timeline moments (item 4),
  coaching talks (item 7).
- Item 8: the purchase link on godspeedmissioncontrol.com/hostinger points at
  `docker/hostinger/one-click.yaml` on `beta`; the release step's promote regenerates that file.
