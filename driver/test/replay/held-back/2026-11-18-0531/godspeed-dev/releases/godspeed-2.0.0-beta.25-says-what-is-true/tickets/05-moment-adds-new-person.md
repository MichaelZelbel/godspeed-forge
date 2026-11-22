Status: done (merge 9922403e5835123bb8ddf9bcbd3ba5d1c09b6eda)

Ticket for 2.0.0-beta.25 (plan item 5). Size: light. Depends on: nothing (continues pull request #582). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
In the add-moment dialog the People field (`notebook/ui/src/components/timeline/PeopleMultiSelect.tsx`) only picks people who exist; a new name shows "No people found." The "Add new people" checkboxes in `AddEventDialog.tsx` appear only after Suggest with AI. The field is hidden when the People list is empty.

## Why
The maintainer asked for it: adding a moment by hand should be able to add a person who is not in People yet.

## Why now
The maintainer's own request; the pull request works and was held back only by the keyboard decision below.

## Owner decision
Decided 2026-11-15 in the approved plan of 2.0.0-beta.25, as a question of how: Enter on a partly typed name selects the existing match; a new person is made only by choosing the explicit "Add ... as a new person" item, which is also the Enter choice when no existing person matches. No accidental duplicates.

## Outcome
Typing a name that matches nobody offers "Add "<name>" as a new person"; choosing it shows the name as a chip marked new. New people are created when the moment is saved, through the same path the AI suggestions use (case-insensitive lookup first, then insert; a failure stops the save). The field shows even with an empty People list. Editing a moment works the same.

## Invariants
- The AI suggestion path behaves as today.
- No duplicate person for a name that exists under another case.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests: a hand-made moment with a new name creates and links that person; a name existing in another case links the existing one; with an empty list the first person can be added; Enter on a partial match selects the match.
- The notebook web page's unit tests and type check pass.

## Done means
The change and its tests exist and pass with the repository's tests.
