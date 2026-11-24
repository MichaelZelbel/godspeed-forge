---
release: godspeed-2.0.0-beta.23-side-by-side
repository: MichaelZelbel/godspeed-mission-control
note: also carries all of 2.0.0-beta.22, which was never frozen on its own (Michael chose beta.23 for his server on 2026-11-12)
---

# Godspeed 2.0.0-beta.23: side by side

Status: approved by Michael on 2026-11-11 ("Yes, if possible, then start it. ... I would like you to
spend your tokens in the next three hours, so if you can let Archon build a lot, that would be
fantastic.")

## Outcome (2026-11-12 07:38 UTC)

Every item merged, nothing cut, about 10 hours 20 minutes after the start (cut-off was 2026-11-13
07:00). 75 laps, 20 pull requests merged by the runner plus 5 by hand (#460 fence, #462 apt mirror,
#468 scenario image, #481 update workflow job; #471 opened by hand from the loop's branch). Factory
cost about 458 USD at API prices (Archon run logs), about 17 percent of a week's allowance,
below the 25 to 35 percent estimate; the hand work in Mission Control's sessions is not in that number.
Live proofs on the products' own code: plain-yes, no-question-he-cannot-judge, update-keeps-everything,
server-update-keeps-everything, telegram-language all PASSED. The nightly of 2026-11-12 did not
run (GitHub skipped the schedule); the release step's candidate run covers it.

What the parallel run showed: eight laps at once only in the first hour; afterwards the open items
were few and chained, so one to three laps ran and most short laps found nothing free. The limiter
was again the shape of the work and the owner questions (fourteen decisions posted by Mission
Control, two of them parked for hours because the watcher read only issue labels, not pull-request
labels). Found along the way and fixed: the button press and every typed answer after the first one
reached the waiting step only by luck on real installs (#482); the factory's end card went to the
wiped VPS (now Godspeed notices).

Timers `godspeed-forge-beta23-deps` and `-cutoff` stopped after the last merge.

## Started (2026-11-11 21:18 UTC)

- Started at once instead of after the reset, at Michael's word: the rest of this week's allowance
  goes first. Unit `godspeed-forge-beta23`, 8 laps, at most 140; log `/var/log/godspeed-forge/beta.23.log`.
- beta.22's runner is left to finish its last lap (#377, PR #449); #377 moved to `beta.23`, so that
  runner ends with its card when the lap ends. Its settle loop was stopped (`settler.stop`) so only
  beta.23's merges. beta.22's cut-off timer was removed (it would have stopped these laps too);
  beta.23's own cut-off is `godspeed-forge-beta23-cutoff` (2026-11-13 07:00 UTC).
- The runner script gained `SKIP_WAIT=1`, so a release can start while another release's last lap
  runs (backup `release-run-parallel.sh.bak-20261111`).
- Issues: items 1 #452, 2 #372, 3 #262, 4 #361, 5 #453 (replaces #391), 6 #415 (owner ruling
  commented), 7 #436, 8 #443, 9 #442, 10 #454, 11 #457, 12 #455, 13 #456, 14 #458, 16 #377.
- Chains: #372, #262, #361, #457, #458 carry `needs-owner` until their dependencies close;
  `godspeed-forge-beta23-deps.timer` (every 3 minutes, `/usr/local/lib/godspeed-forge/beta23-deps.sh`)
  lifts it and logs the release in beta.23.log.
- The holdout fence (#417, #425) is narrowed by Mission Control's coding helper in parallel: PR #460,
  merged 22:1x UTC (Codex review, five rounds; release App approval).
- #442 parked by the loop (its files are protected from the factory): done by hand, PR #462, merged
  (fresh Opus review; release App approval; the pull_request `required` run rerun after the approval).
- Owner decisions posted by Mission Control (how-questions delegated by the plan): PR #446 may change
  what its test judges (merged); #453 gets a diagnostic-plus-fix PR; #456 option B (no host-side
  privileged unit on Docker; the Update now button on Docker shows the line to run; option A is
  Michael's for later), and #458 accordingly not offered on Docker.
- #452 landed as PR #463 with its live scenarios moved to the release step (planner rule). #467
  (scenarios could only prove an ancestor's server image) done by hand, PR #468: a missing image now
  fails plainly, and `scenarios.yml -f pr=<n> -f only=<jobs>` proves a pull request's own head. Its
  first proof on #463's head: plain-yes and no-question-he-cannot-judge still FAIL (posted on #372,
  #262). Main's image job fails one notebook test since about #459: new item #470, `priority`.
- The factory's end card bounced on the wiped VPS; the AX41 relay now queues a notice in Michael's
  own Godspeed (procedures.md). beta.22's card was said on Telegram at about 23:10 UTC.
- #456: the loop's work was kept after its push was refused for touching `scenarios.yml`; Mission
  Control dropped that file from the branch and opened PR #471 (merged 23:56 UTC); the workflow job
  went in by hand as PR #481 (Codex and Opus review). Both update scenarios PASSED on main, run
  43134770873. #470 fixed by PR #472; main's image builds green again from 23:53 UTC.
- #372: the send side of #463 works; a `gss1` button press is not answered in the scenario
  environment (typed yes works). Decision posted: diagnose-then-fix PR, Mission Control runs
  `-f pr=<n> -f only=plain-yes` on its head.
- The deps helper re-released a parked item once (#457); it now releases each item only once.
- At 22:15 UTC: 7 laps running (plus beta.22's last), load 24 on 12 threads; #436, #442, #443 merged.

The third release built by Cole Medin's factory and the second in parallel. Michael asked to plan it
"so that we use as much parallelization in our Forge software factory based on Archon as possible.
Let's try out if we can have a lot of development going on in parallel, if that's possible."

## What beta.22 taught about parallel laps

From the runner's log (`/var/log/godspeed-forge/beta.22.log` on the AX41), 2026-11-11 11:26 to 18:54 UTC:

- 74 laps for 21 merged pull requests. Eight laps ran at once only once; most of the time three to
  five ran. 18 laps ended within a minute because nothing was free to claim.
- The limit was the work, not the machine: 14 open items at the start, several in the same folders
  (Cole's pick skips an item whose area a live claim touches), and every hook item blocked by the
  holdout fence until Michael's own hand-merges (#417, #425). The AX41 sat at load 1.4 of 12 threads.
- Cost: about 430 USD at API prices (Archon's own run logs), about 16 percent of a week's Claude
  allowance (`cost-meter.json`: 2,700 USD a week). About 20 USD per merged pull request.
- More laps than eight is not the answer: the notebook suite already fails under load 10 to 14
  (#443), so more laps would buy flaky checks, not speed.

So this release raises parallelism by shaping the work: many items, each in its own folder, ready
at the first minute, with the one known blocker removed before the first lap.

## What it delivers (what changes for the person)

1. A routine's question reaches Telegram as one message with its Yes/No buttons, never twice and
   never with the buttons arriving after the answer. Michael's yes on this design, 2026-11-11. (#452)
2. A plain "yes" or a button press answers the right waiting step, proved by its scenario. (#372,
   after 1)
3. Background work asks nothing the person cannot judge, and never for a code, proved by its
   scenario. (#262, after 1)
4. The release check installs Godspeed once per system and runs every check in that install:
   minutes instead of over an hour, and a fraction of the scenario AI key's money (now 10 USD a
   month). PR #426 continues. (#361, after 2 and 3)
5. Telegram answers in the language of the message: an English journal entry got a German answer
   in the nightly run of 2026-11-11. (new issue from #391)
6. A rhythm change the person makes on purpose no longer turns the dropped day into a talk day;
   beta.22's ruling covers only a change nobody asked for. (#415)
7. The daily connection check, which setup adds only when wanted, gets its promise file like every
   other starting routine, so a missed run shows at the top of the morning list. (#436)
8. The notebook's refresh test passes on a busy machine, so parallel laps stop failing on it. PR #446
   continues. (#443)
9. The server image check installs its browser again (the runner's package mirror). (#442)
10. The journal understands when something really happened: "an hour ago", "at 11", "yesterday
    afternoon", "from 9 to 10:30", and asks once when unsure. (Discussion #25, new issue)
11. Every finished journal task also becomes a moment in the notebook's timeline, usually as
    everyday, sometimes higher, checked with the person when unsure. (Discussion #10, new issue,
    after 10)
12. The person chooses whether Godspeed adds a new rule on its own or shows it first to add, edit or
    dismiss, and offers to change a similar rule instead of making a second. (Discussion #102, new
    issue)
13. One command and an "Update now" button update Godspeed to the newest stable release, showing the
    installed and available versions and what changed, keeping everything the person has.
    (Discussion #35, new issue)
14. Optional automatic updates to stable releases, with pause and a chosen time. (Discussion #35,
    new issue, after 13)
15. Every scenario that still fails in the nightly run of 2026-11-12 02:30 UTC for a reason other
    than the scenario AI key becomes its own item, labelled the same morning. The run of
    2026-11-11 failed nine of eleven on the key's old 2 USD limit; only telegram-language (item 5)
    and update-keeps-everything showed another cause.
16. The first-day scenario (#377, PR #449), if beta.22's runner has not merged it by its cut-off.

## Lanes at the first minute

Nine items need nothing else and lie in separate folders, so all eight slots fill from the start:
1, 5, 6, 7, 8, 9, 10, 12, 13. Chains: 2 and 3 after 1; 4 after 2 and 3; 11 after 10; 14 after 13.
Item 15 joins on the morning of 2026-11-12. Each ticket names the folders it changes, so the
loop's overlap check sees which items can run side by side.

## Beside the factory, at the same time (Mission Control, not the factory)

- Before the first lap: narrow the holdout fence so it guards only the factory's own files, not
  `starter-godspeed/.claude/settings.json` or shell text that merely names a fenced file (#417,
  #425). The fence guards itself, so the factory cannot make this change; Mission Control's coding
  helper does, with a second AI's review.
- Move the private `approve <code>` gate on Michael's server into Godspeed's waiting steps, so he
  runs the same Godspeed as every user (#413; needs his server, out of the factory's reach).
- Bring the coach and journal add-on repositories level with the copies the product carries
  (#299), after items 6, 10 and 11 merge.
- beta.22's release step and its guide pages.

## What it does not do

- Contract switching (#379, the homepage example): needs Michael's answer on whether Godspeed
  carries out the switch or prepares it for one click; if he wants it in, it splits into four
  parallel items (finding the contracts, noticing a price rise, comparing offers, the yes card).
- One home for everything (#90), pictures and PDFs leaving the computer (#57), weak checks on daily
  work (#279, needs a design), the known issues (#1, #2, #7).
- The other ideas in Discussions.

## How it is built

- Each item is one issue labelled `beta.23`; every other open issue stays `needs-owner`. New issues
  for items 5 and 10 to 14 are written from the discussions in Mission Control's own words, with
  the planner's headings (problem, why, why now, outcome, invariants with the blocking line,
  acceptance) and the folders each changes.
- Runner: `release-run-parallel.sh beta.23 8 120` on the AX41, started after beta.22's runner ends
  and after the weekly allowance resets (2026-11-12 00:00 UTC). Remove beta.22's `.factory/STOP`
  first.
- Merging: as beta.22, the reviewer's verdict for the exact head plus the green `required` check.
- Caps: three attempts or two send-backs per item, then `needs-owner`; the others go on.

## Cutting instead of blocking

Michael's rule from beta.22 holds: an item that reaches a dead end (parked twice on the same cause,
or needs a different design than the one decided) or is not merged by **2026-11-13 07:00 UTC**
leaves the release, its scenario marked not blocking, and goes into the next plan with what was
learned. What merged is released.

## Proving

- Every pull request: `required` and Cole's app check against `harness/END-TO-END.md`.
- The release step: the nightly proving scenarios on the candidate, one install per system once
  item 4 is in.

Added at the release step (2026-11-12): the candidate also carries beta.22, so the blocking jobs
are those that prove the items of both releases. A failed scenario job is blocking when its name
contains one of these phrases (the release tools read the list).

**Blocking scenarios:**

- a plain yes or a button answers the right waiting step (beta.23 items 1 and 2, #452, #372)
- background work asks nothing the owner cannot judge (item 3, #262)
- Telegram answers in the language of the message (item 5, #453)
- a Docker server updates from the current public version with godspeed-update (item 13, #456)
- a fresh Docker server turns a first goal into useful work (item 16, #377)
- a talk says when its preparation did not pass (item 6 and beta.22 item 8, #415, #359)
- right after a background report, "what is this about?" is answered from what was sent (beta.22 item 6, #191)
- a stranger's Linux install (beta.22 item 9, #395)

Every other scenario job that fails is named in the result with its cause and does not block.

Corrected at the release step (2026-11-13, before any go): the Charm Challenge job was first listed
here for beta.22 item 12 (#340), but #340 only made the job keep its evidence; the job itself fails
the same way on main before this release (#389, filed 2026-11-10: on the first day the chat says
nothing about restarts), so it is not a feature of this release and does not block it.

## Cost estimate

beta.22: about 430 USD at API prices for 21 pull requests (16 percent of a week). Here 16 items, two
of them large (4 and 13), so about 30 to 40 pull requests with follow-ups: about 600 to 900 USD,
**25 to 35 percent of a week's Claude allowance**, from the fresh week that starts tonight. Nothing on
OpenAI. Scenario AI: the nightly runs on the 10 USD a month key.

## After go

- Guide pages: Telegram questions (1), journal times and moments (10, 11), rules choice (12),
  updating Godspeed (13, 14).
