---
release: godspeed-2.0.0-beta.27-sees-it-through
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.27: sees it through

Status: approved by standing decision (Michael, 2026-11-17: "Yes, build those three And roll them out."; bug-fix-only releases start without his yes)

Proposed by Mission Control as godspeed-2.0.0-beta.27-sees-it-through; refreshed against the open issues and started by auto-plan on 2026-11-17, once 2.0.0-beta.26 was on his server and ready. Only bugs and items left over from 2.0.0-beta.26; new features still wait for his yes.

## What it delivers (what changes for the person)

1. Right after a restart, the notebook waits for its server to become ready and opens instead of showing a reconnect error.
2. Chats, model choices and the AI card say when the AI key was refused, distinguish that from an outage, and notice recovery without a reload.
3. A failed AI connection cannot be hidden briefly by an older ready result.
4. A coaching talk prepared through the installed notebook comes out ready when its preparation meets the existing requirements.
5. Every supported chat surface returns the same saved, filtered morning briefing instead of substituting an ordinary answer.

Issues: item 1 #679, 2 #590, 3 #667, 4 #670, 5 #596

## How each is decided (questions of how, decided here, not Michael's)

- Item 1 keeps the beta.26 decision. Measure the work done during the first seconds after a restart and remove the cause of the late first answer. If correct startup work must finish first, the sign-in gate waits and says the server is starting. The fresh-server check keeps its existing assertions and timeouts.
- Item 2 keeps the split already established for the continuing work: a provider refusal is described as a key problem with a useful next step, while timeouts, server errors and unreachable providers are described as outages. An open chat refreshes the state within about five seconds. Existing holdouts keep the same bar.
- Item 3 keeps the continuing change's ordering rule: a failed shared check wins over a cached ready result for every overlapping reader. Ready can return only after a newer successful check.
- Item 4 keeps the existing preparation-quality rules. The normal installation must contain everything its listed coaching preparation needs. A preparation that meets those rules is ready and opens the talk; one that does not remains a draft and explains why.
- Item 5 uses the corrected, scenario-specific saved-briefing evidence. The chats must return the stored filtered briefing itself, including its accepted next step and Charm Challenge line when present. The verifier may be corrected or tightened to preserve exact attribution and evidence, but its required result may not be loosened.

## What it does not do

- The maintained verification-route chain in #697, #616 and #652 is not included. Its declared dependencies form a circle, so there is no valid order in which the required earlier issues can be built. The three stay together outside this release until that dependency record is corrected.
- Contract switching (#379) and moving the owner's private approval gate into Godspeed (#413) still need Michael's answer before their new behavior can be planned.
- Factory Telegram question handling (#600) is factory machinery outside this product release and needs separate owner scope.
- It does not add any feature or alter what a hidden check requires.

## How it is built

Cole Medin's factory builds one issue at a time. Items 2 and 3 continue their existing pull requests where useful; every item keeps its listed issue. Only these issues receive the release label and become eligible for the loop. Other open work stays held. Caps: three attempts or two send-backs per item, then `needs-owner`; an item that reaches a dead end leaves the release, the rest ships.

Every pull request runs the repository tests, the required gate and the integrated Godspeed check before merge.

## Proving

- Every pull request must pass the required gate and the integrated installed-product check.
- On the release candidate, the fresh installed server and browser scenario proves restart recovery.
- The coaching scenario proves both outcomes: a qualifying preparation opens a talk, while a preparation that fails the requirements remains a draft and says why.
- The saved-briefing scenario proves that each supported chat surface returns the same stored filtered result.
- Hidden scenarios in godspeed-holdouts prove the existing AI-state, coaching and saved-briefing requirements. No hidden requirement is loosened.
- A scenario failure caused by the candidate blocks the release. A separately evidenced test-machine failure is reported with its cause and does not become a pass.

## Cost estimate

No factory ledger is available yet. Two items continue existing pull requests, one requires startup measurement, and two exercise installed user journeys. The expected cost is about 6 to 9 percent of the weekly allowance, roughly 120,000 to 180,000 tokens, plus the normal release-candidate scenario runs.

## After go

- Review and, where the person-visible behavior changed, update the guide pages for server restarts, Your AI and the chats, coaching talks, and morning briefings.
- Run `node .github/guide-check.mjs`, review every named page in the website repository, regenerate the guide map from page sources if coverage changed, and record the required `Guide-Reviewed` trailer in the release commit.
