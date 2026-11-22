---
release: godspeed-2.0.0-beta.27-sees-it-through
repository: MichaelZelbel/godspeed-mission-control
---

# Godspeed 2.0.0-beta.27: sees it through

Status: proposed (2026-11-17). Michael asked: "Plan Release Godspeed Beta".

The theme: finish what beta.26 could not, and give the hidden checks the routes they need, so
those items can be proven instead of reported as "could not run". No new features.

## Where beta.26 stands (2026-11-17, morning UTC)

Approved 2026-11-16. Done and merged: the security fixes of the notebook's building blocks
(#615), the screens and starter files that promised too much (#664), the Hostinger button on the
current version (#663), the Hevy scenario's own key (#685), the waiting-steps clock (#680).

Not done:

- #590 (the chat says a refused key is a refused key) and #670 (the coaching preparation comes
  out ready) each reached the factory's cap of two send-backs on 2026-11-16 and wait on an owner
  decision.
- #667 (no "ready" right after a failed check) is open with PR #671, unmerged.
- #669 (a Timeline moment linked to an existing person) closed with PR #672, but the full check
  on main 57b0c58 found the People control missing from the visible Add moment dialog (#697). For
  the person, the item is not delivered.
- #679 (a restart answers at once) was already moved by Michael's decision of 2026-11-16 to a
  later release.

Proposal for beta.26, following its own rule (an item that reaches a dead end leaves the release
and the rest ships): it ships with #615, #664, #663, #685 and #680; #590, #667, #669/#697 and #670
move here. On his yes, a `scope-amendment.json` in beta.26 records it with his words.

## What it delivers (what changes for the person)

1. **Right after a restart the server answers at once** instead of showing "Let's reconnect" for
   a while. (#679) Full.
2. **A chat says plainly when the AI key was refused, and a chat that is already open notices by
   itself when the AI comes back.** (#590, continuing PR #660.) Full.
3. **A chat never briefly shows the AI as ready right after its connection failed.** (#667,
   continuing PR #671.) Light.
4. **Adding a moment to the Timeline lets you pick a person who already exists, in the normal
   dialog.** (#697, finishing #669.) Light.
5. **A coaching talk prepared on an installed Godspeed comes out ready to use.** (#670) Full.
6. **The hidden checks can finally try the coaching talks, the Timeline, the assistant journeys
   and the saved briefing**, instead of reporting "could not run". (#616 with PR #618, #652, #596.)
   Full.
7. **The guide check stops repeating old warnings**, so a new real one stands out. (#695) Light.

Issues: item 1 #679, 2 #590, 3 #667, 4 #697, 5 #670, 6 #616 / #652 / #596, 7 #695

## How each is decided (questions of how, decided here, not Michael's)

- **Item 1:** unchanged from beta.26's plan: measure what the server does in its first seconds
  after `docker restart` (index rebuild, store verify, Git, the add-ons) and why `/api/query`
  misses the sign-in gate's 15 seconds; make the first answer prompt; if startup work must run
  first, the gate says the server is starting and waits for readiness instead of failing. The
  fresh-server check's assertions stay exactly as they are.
- **Item 2:** PR #660's split stays: a refused key (401/403) is said as a refused key with what to
  do; an outage (timeout, 5xx, no route) as an outage. The loop's three remaining blockers of
  2026-11-16 are decided here: (a) an already open chat updates its AI state within about five
  seconds after a reconnect, without a reload; that is product behaviour and is in scope; (b) the
  failing guide check on the head is fixed in this item's PR, not loosened; (c) H-28's Settings
  observation is completed by the route work of item 6, so item 2 does not wait for it beyond
  that. Owner decision: a new correction lap is authorized; H-19..H-26, H-28 and H-29 judge it,
  unchanged.
- **Item 3:** a failed in-flight health check wins over any cached ready value for every reader
  that overlaps it (PR #671's approach). No visible "ready" after a failure until a newer check
  passes.
- **Item 4:** the People control appears in the visible manual Add moment dialog on a fresh
  install; picking a person, saving and reloading shows the same link and leaves the person record
  unchanged. The maintained browser check opens exactly that dialog and fails if the control is
  absent. #672's direct and server boundary behaviour stays. Depends on item 6's route for its
  holdout (H-32), not for its code.
- **Item 5:** the loop found that a clean install filters out the `coach-prep` routine because the
  skill it needs is not installed. Decision: the normal install ships and registers that skill,
  because coaching talks are part of Godspeed and a routine the product lists must be able to run.
  The routine produces `STATE: ready` for the supported clean fixture through its visible selector
  and Run now; the preparation-quality requirements and H-14..H-17 stay unchanged.
- **Item 6:** the repository routes (#616, continuing PR #618) give H-14..H-17, H-30 and H-32 a
  maintained public entry a clean checkout can run, using the installed boundary a person uses,
  never private helpers. #652 makes the fenced verifier call them and account for every registered
  ID exactly once (H-01 and H-33 separately). #596: the product already returns the saved
  briefing byte for byte (measured 2026-11-16); the verifier's fixture gives H-18 its own draft,
  matched exactly, so H-04's replies are not consumed. A route crash stays INCOMPLETE with
  evidence, never PASS. No holdout changes what it judges.
- **Item 7:** the historical malformed or obsolete `Guide-Reviewed` tokens are corrected or shown
  as history only; a newly introduced bad token still fails, and the self-test proves it.

## What it does not do

- Contract switching (#379), one home for everything (#90), weak checks on daily work (#279), the
  coach add-on copy against its pin (#299), the owner's private approval gate (#413): each still
  needs Michael's answer or a design.
- The known issues (#1, #2, #7).
- The factory's Telegram questions (#600) and the factory machine's own notebook service blocking
  its native-install check (#698): Mission Control's machinery, handled outside the product.

## How it is built

Cole Medin's factory on the AX41. Items 2, 3 and 6 continue their open pull requests (#660, #671,
#618); the others keep their issues. Each issue gets its ticket text as an `Owner decision`
comment and the label `beta.27`; `needs-owner` comes off it and its pull request. Everything else
stays `needs-owner`. Caps: three attempts or two send-backs per item, then `needs-owner`; an item
that reaches a dead end leaves the release, the rest ships. Every pull request runs the integrated
tests before it can merge (D-420).

## Proving

- Every pull request: `required` (which waits for "Integrated Godspeed v2") and Cole's app check
  against `harness/END-TO-END.md`.
- The release step: the proving scenarios on the candidate.

**Blocking scenarios:**

- the fresh installed server and browser check, restart included (item 1)
- a talk says when its preparation did not pass, and opens from one that did (item 5)
- two computers that move the same reminders at once (it failed every night to 2026-11-16 for a
  missing token; PR #681 merged after that run, so the next nightly shows whether it is fixed)
- hidden scenarios in godspeed-holdouts: H-19..H-26, H-28, H-29 (items 2, 3), H-14..H-17 (item 5),
  H-32 (item 4), H-18 and H-30 (item 6)

Every other failing job is named with its cause and does not block (standing rule of 8 November
2026).

## Cost estimate

No ledger measures the factory yet. Three items continue open pull requests, one needs a
measurement first (1), one an install change (5), and item 6 spans the repository and the fenced
verifier: about 8 to 12 percent of a week of the ChatGPT plan the factory builds on (D-415), plus a
small Claude share for planning and the release step.

## After go

- Guide pages: "Your AI and the chats" (items 2, 3), timeline moments (item 4), coaching talks
  (item 5), the restart note in the server guide (item 1).
