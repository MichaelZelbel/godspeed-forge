---
release: godspeed-2.0.0-beta.28-watches-your-contracts
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.28: watches your contracts

Status: withdrawn (2026-11-17): Michael: "put that to the back burner until you actually know how to do this, and select another feature." Contract watching (#379) waits until the routes are proven; a new proposal replaces this one.
starts after 2.0.0-beta.27, which is in flight as a bug-fix release on his standing decision, is
on his server: one release at a time.

The theme: the first feature release after five bug-fix rounds. Two bugs that every plan since
beta.25 deferred "for Michael's answer" go in first, because neither needs his answer, only a
decision of how, made here. Then the first complete journey of contract watching (#379), built
on the owner decisions he gave on 2026-11-12, for Germany and two kinds of contract.

## What it delivers (what changes for the person)

1. **The coach installed with Godspeed is exactly the coach its own project released**, so a
   coach update can no longer silently undo a fix. (#299) Light.
2. **Godspeed calls a piece of daily work ready only when a check of its content passed, and the
   morning message no longer lists approvals that already closed.** (#279) Full.
3. **Godspeed keeps a list of your running contracts** (provider, kind, price, minimum term,
   notice period, next date that matters, who looks after it, where each fact came from), filled
   from the letters the Clerk reads and what you say in chat. You confirm each found contract once.
   Full.
4. **When your health insurer raises its extra contribution** (seen on a pay slip, a letter or the
   published rates), you get one message: what it costs you a year, the last day you can leave, and
   an application to a cheaper insurer, prepared. Nothing is sent without your yes. Full.
5. **Your electricity contract gets an automatic switching service offered once** (a free one
   named first, no paid placement), and if a year passes without a switch confirmation, Godspeed
   says so once. Light.
6. **A kind of contract Godspeed has no researched route for gets no advice**, only a plain "I do
   not know a good route for this yet". Light.

Issues: item 1 #299, 2 #279 (items 3 to 6 get new issues on his yes, split from #379)

## How each is decided (questions of how, decided here, not Michael's)

- **Item 1:** the coach changes made inside the product's carried copy go into the godspeed-coach
  repository first; the carried copy is then brought back by `vendor-addons.py` and pinned to that
  commit, so `--check` passes for every add-on. Reason: the add-on's own repository is the source of
  truth (process.md, carried copies); fixing the copy alone would recur.
- **Item 2:** a work item's check must read the result against the task's own done-means, never
  count headings or words; the morning message takes approvals only from the current decision.
  The installed established-workspace scenario named in #279 proves it. #268 stays separate.
- **Item 3:** contracts are notebook pages (a new record type beside Deadlines), so they sync like
  everything else (#90's direction). The Clerk already extracts contract notice periods
  (`terms_of: "contract"`); it hands a found contract to the notebook through the add-on door the
  way it hands deadlines today. No bank export in this release: transaction readers find recurring
  payments well but err, and the letters plus chat give a first version to judge first.
- **Items 4 to 6:** routes are researched, dated playbooks (knowledge, not code), one per kind of
  contract per country, each with its sources and the date checked, rechecked every three months
  and at once when a source changes; a running watch follows the playbook's current version.
  Health insurance first because since 30 July 2026 insurers no longer tell members individually
  about the special right, and January rate rises are when it matters. Electricity second because
  it proves the "a service does it every year" pattern and the yearly follow-up. Godspeed prepares,
  the person switches and signs; it never submits anything itself (owner decision, 2026-11-12). No
  provider connections and no reading of comparison calculators through the browser.
- **No prices and no quotes are fetched anywhere in this release** (Michael asked on 2026-11-17
  how Godspeed would get them). Statutory health insurance has no quotes: each insurer's price is
  one extra-contribution rate, and the GKV-Spitzenverband must publish every insurer's current rate
  in a daily-updated list (§ 242 Abs. 5 SGB V). Godspeed reads that list once a day; the yearly
  cost is the person's contributory income (from a pay slip the Clerk read, or asked once) times
  the rate difference, employee half. A new rate shows in the list from the day it applies, and the
  special right runs to the end of that month, so the person still has the month. Private health
  insurance needs quotes and is out. Electricity: Godspeed never compares prices; it names a
  switching service that compares and switches for a living, and later only looks for a switch
  confirmation in what the Clerk and mail already read; when it finds none, it asks the person
  once instead of claiming no switch happened.

## What it does not do

- Car insurance: its cancellation window closes on 30 November, before this release can reach
  anyone; it comes for next autumn's window. Internet and mobile, broker apps, and the bank export
  come after this first journey has been tried.
- Moving the owner's private approval gate into Godspeed (#413): it runs on his own server, so it
  is Mission Control's work, not the factory's.
- One home for everything (#90) beyond what item 3 adds; Mac setup (#1), subscription sign-in
  walkthrough (#2), two entries in Windows Apps on a PC that still has the first edition (#7).
- The verification-route chain (#697, #616, #652) and the factory's Telegram questions (#600), as in
  beta.27.

## How it is built

Cole Medin's factory on the AX41, one issue per item, labelled `beta.28`; everything else stays
`needs-owner`. Items 3 to 6 build in order (4, 5 and 6 need item 3's contract pages); 1 and 2 are
independent and start at once. Caps: three attempts or two send-backs per item, then `needs-owner`;
an item that reaches a dead end leaves the release, the rest ships.

## Proving

- Every pull request: `required` (which waits for "Integrated Godspeed v2") and Cole's app check.
- Open scenarios on the candidate, on a test install set in Germany:
  - a pay slip with a higher extra contribution brings exactly one message with the yearly cost,
    the deadline and a prepared application, and nothing leaves the machine without a yes;
  - an electricity contract with no service gets the service offered once; a simulated year with no
    switch confirmation brings one notice;
  - a contract of a kind with no playbook gets no advice;
  - a letter read by the Clerk adds a contract that the person confirms once;
  - the coach add-on check passes for every add-on; an installed established workspace with a weak
    draft is not called ready.
- New hidden scenarios in godspeed-holdouts for items 3 to 6; no existing one is loosened.

## Cost estimate

No factory ledger exists for the recent releases (`cost-meter.mjs report` finds none since
beta.24). From beta.27's estimate of 6 to 9 percent for five bug items, and this release adding a
new record type, two researched playbooks and new scenarios: about 15 to 20 percent of the weekly
allowance, roughly 300,000 to 400,000 tokens, plus the release-candidate scenario runs.

## After go

- The homepage example on godspeedmissioncontrol.com ("Say yes and I'll switch you") describes a
  mechanism Godspeed does not have; replace it with the health-insurance message this release
  really sends.
- New guide page for contracts; review the Clerk and morning-brief pages.
- Run `node .github/guide-check.mjs` and record the `Guide-Reviewed` trailer in the release commit.
