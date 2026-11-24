Ticket for 2.0.0-beta.25 (plan item 3). Size: light. Depends on: nothing (continues pull request #579). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
1. After an AI is connected, every model picker shows the placeholder "Connected model", and `GET /api/chat/options` names no model; a chat tab opened before connecting keeps saying "No AI connected".
2. With the AI key refused, or the AI stopped, the Dashboard card says "Ready to chat", the pickers say "Connected model", and replies are the raw provider text (for example HTTP 401 "Incorrect API key") with no pointer to Settings.
3. A note's toolbar button labelled only "AI" (`notebook/ui/src/components/common/AiVisibilityButton.tsx`) hides the note from AI in one click; only a tooltip and a toast say so.

## Why
The notebook says it is ready when it is not, and a one-word button silently removes a note from People, the Note Graph, AI Chat and MCP.

## Why now
Holdouts H-24, H-25, H-26 and H-29 fail on main for this; the pull request is built and reviewed and was held back only by the decision below.

## Owner decision
Decided 2026-11-15 in the approved plan of 2.0.0-beta.25, as a question of how: the shown state may lag the real one by about five seconds and must correct itself without a reload. The reviewers measured this window and accepted it; the merge gate accepts it too. No looser case is approved.

## Outcome
Pickers and `GET /api/chat/options` name the model saved in Settings, Your AI; an open chat tab picks up a newly connected AI. A refused key or an unreachable AI shows as such on the card and in the pickers, within about five seconds, with a pointer to Settings instead of raw provider text. The note button's visible label says what it does (for example "Hidden from AI" / "Visible to AI").

## Invariants
- A working AI is never shown as broken.
- The note's AI visibility works as today; only its label changes.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- Tests for the model name in pickers and options, for refused and stopped states on the card, and for the note button's label.
- The notebook web page's unit tests and type check pass.

## Done means
The change and its tests exist and pass with the repository's tests.
