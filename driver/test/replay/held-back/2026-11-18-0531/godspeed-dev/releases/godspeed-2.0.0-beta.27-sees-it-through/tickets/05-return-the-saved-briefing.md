Ticket for 2.0.0-beta.27 (plan item 5). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #596.

## Owner decision

The saved-briefing verifier must use its own exact scenario response and retain the request, response, AI record, saved note, time context and tested revision. Changes to the verifier or fixture are approved only when they correct attribution or make the requirement stricter. They may not accept a substitute briefing, omit a supported chat surface, or loosen exact comparison with the stored result.

## Problem

After a filtered morning briefing is saved, some supported chat paths can return an ordinary stand-in answer instead of that saved result. The person can therefore receive different versions of the same morning depending on where they ask.

## Why

A saved briefing is the agreed result for that day. Rewriting or replacing it can restore material the person filtered out and can lose an accepted next step or challenge.

## Why now

Earlier evidence was confused by a fixture attribution fault. That attribution has been separated, and the corrected observation still reproduces different answers across supported surfaces.

## Outcome

Every supported chat surface returns the same stored, filtered morning briefing for the day. It preserves the saved wording and includes the accepted next step and Charm Challenge line exactly when the stored briefing contains them. No surface drafts a substitute.

## Invariants

- The saved briefing remains the source of truth after it exists.
- Sentences filtered out before saving must not reappear.
- Do not weaken the saved-briefing judge or replace missing evidence with a pass.
- Preserve exact, scenario-specific evidence attribution and provenance.
- Do not send briefing content to any new service or destination.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance

- Tests save a filtered briefing and request it through every supported chat surface.
- Each returned result matches the stored briefing and does not contain a sentence that was filtered out.
- Tests cover a stored accepted next step and a stored Charm Challenge line, including their absence when they were not saved.
- The scenario retains its exact request, response, AI, note, time and revision evidence.
- A route failure or missing observation cannot pass.
- The repository tests and integrated installed-product check pass.

## Done means

Every supported chat surface returns the stored filtered briefing in the focused tests, the corrected evidence remains attributable, and all repository checks pass.
