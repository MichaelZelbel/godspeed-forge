---
release: godspeed-2.0.0-beta.28-keeps-watch
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.28: keeps watch

Status: approved by Michael on 2026-11-17 ("Yes, start it")

Proposed by Mission Control the same day on his "Plan release Godspeed beta"; it replaces the withdrawn
`godspeed-2.0.0-beta.28-watches-your-contracts`, which he sent to the back burner ("select another
feature"). On his "start it" the build starts at once, beside 2.0.0-beta.27 (as beta.23 ran beside
beta.22, D-410): only item 2 may touch the same
morning-briefing code as beta.27's item 5, and whichever merges second rebases; whatever of beta.28
has merged when beta.27 freezes simply ships with it.

The theme: three things Michael's server has done for him privately every day for months move into
Godspeed for every user (rule `same-godspeed-as-every-user`), and his server then drops its private
copies. Each is chosen because its mechanism is already proven by the private job running daily,
so nothing here is a guess. Two bugs every plan since beta.25 deferred go in first; neither needs
his answer, only a decision of how, made here.

## What it delivers (what changes for the person)

1. **The coach installed with Godspeed is exactly the coach its own project released**, so a
   coach update can no longer silently undo a fix. (#299) Light.
2. **Godspeed calls a piece of daily work ready only when a check of its content passed, and the
   morning message no longer lists approvals that already closed.** (#279) Full.
3. **Godspeed tells you once when today's AI spending on your OpenRouter key passes your daily
   limit, or when your credit is about to run out**, with both amounts in Settings. Light.
4. **A yes-or-no question Godspeed asked you that sits unanswered for six hours gets one reminder,
   never a second.** Light.
5. **Tell Godspeed a web address you want, and it tells you the moment it can be registered**, with
   a warning about five days ahead when the current owner's registration is about to lapse. Light.

Issues: item 1 #299, 2 #279, 3 #704, 4 #705, 5 #706

## How each is decided (questions of how, decided here, not Michael's)

- **Item 1:** the coach changes made inside the product's carried copy go into the godspeed-coach
  repository first; the carried copy is then brought back by `vendor-addons.py` and pinned to that
  commit, so `--check` passes for every add-on. The add-on's own repository is the source of truth;
  fixing the copy alone would recur.
- **Item 2:** a work item's check reads the result against the task's own done-means, never counts
  headings or words; the morning message takes approvals only from the current decision. The
  installed established-workspace scenario named in #279 proves it. #268 stays separate.
- **Item 3, from the engine's `mc-spend-guard` (hourly since August):** the notebook calls
  OpenRouter's `GET /api/v1/key` for each key it holds and sums `usage_daily`, and `GET
  /api/v1/credits` for the balance. Defaults as the private job: a notice past 2 USD in a day and
  below 5 USD of credit, each kind at most once every six hours. It is a record routine the
  notebook's own scheduler runs (beside `watch` in `NativeScheduler.recordKinds`), on by default
  when an OpenRouter key exists, silent otherwise. The product's generic `spend-guard` job kind and
  its hand-configured balance connector are replaced by this, not kept beside it. The Kimi capacity
  probe in the private script is Michael's subscription and is not carried over. A provider other
  than OpenRouter gets no spend check yet, and Settings says so.
- **Item 4, from the engine's `do_you_copy.py` (hourly):** the same rule on the product's own
  waiting steps (`waiting-steps.mjs`): pending, its question delivered, older than six hours,
  younger than seven days, not expired. One self-contained reminder through the same channel, a
  marker written only after a successful send, so a failed send is retried next hour and a sent
  one never repeats.
- **Item 5, from the engine's `domain-watch.sh` (every six hours):** the product's `domain-watch`
  kind (already scheduled, but sharing the page-change code) gets the private job's registry
  lookup: RDAP, free and keyless, `rdap.verisign.com` for .com and .net, otherwise `rdap.org`
  with `rdap.net` as fallback; four states (available, pending delete, redemption, registered),
  speaking only on a change, with fixed advice per state. A generic User-Agent, never a person's
  mail address. Added from the chat ("watch the domain example.com") and in Settings.
- **After release on his server:** the engine jobs `spend-guard`, `do-you-copy` and
  `domain-watch` are switched off and his settings carry their thresholds and domains, so he gets
  these notices from Godspeed exactly as a user does. That is Mission Control's step, not a ticket.

## What it does not do

- Contract watching (#379): on the back burner until each route is proven (Michael, 2026-11-17).
- The night-before rehearsal of the morning briefing and an "are my sites up" check over the Links
  collection: their code exists in the product but nothing runs them; they are the next candidates.
- Moving the owner's private approval gate (#413) into Godspeed: it runs on his own server, so it
  is Mission Control's work. One home for everything (#90); Mac setup (#1); subscription sign-in
  walkthrough (#2); two entries in Windows Apps on a PC with the first edition (#7).
- The verification-route chain (#697, #616, #652) and the factory's Telegram questions (#600).

## How it is built

Cole Medin's factory on the AX41, one issue per item, labelled `beta.28`; everything else stays
`needs-owner`. The five items start at once. Item 1 needs the coach changes in the godspeed-coach
repository first; Mission Control's coding helper makes that commit, and the ticket re-pins to it. Caps: three attempts or two
send-backs per item, then `needs-owner`; an item that reaches a dead end leaves the release, the
rest ships.

## Proving

- Every pull request: `required` (which waits for "Integrated Godspeed v2") and Cole's app check.
- Open scenarios on the candidate:
  - a stubbed OpenRouter answering 2.50 USD spent today brings exactly one notice in six hours,
    and none without an OpenRouter key;
  - a waiting step left unanswered for six hours gets one reminder, a failed send is retried, and
    a seventh hour sends nothing more;
  - a watched domain whose stubbed RDAP answer moves from registered to pending delete to available
    brings one notice per change and none while it stays the same;
  - the coach add-on check passes for every add-on; an installed established workspace with a weak
    draft is not called ready.
- New hidden scenarios in godspeed-holdouts for items 3 to 5; no existing one is loosened.

## Cost estimate

No factory ledger exists for the recent releases. From beta.27's estimate of 6 to 9 percent for
five bug items, and three of these items being ports of working code: about 8 to 12 percent of the
weekly allowance, roughly 160,000 to 240,000 tokens, plus the release-candidate scenario runs.

## After go

- Guide: a page for spending notices and domain watching, and the waiting-steps page gains the
  reminder. Run `node .github/guide-check.mjs` and record the `Guide-Reviewed` trailer.
