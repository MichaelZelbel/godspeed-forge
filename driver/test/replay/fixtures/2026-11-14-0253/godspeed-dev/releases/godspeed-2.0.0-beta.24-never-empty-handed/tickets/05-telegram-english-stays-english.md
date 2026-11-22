Ticket for 2.0.0-beta.24 (plan item 5). Size: light. Depends on: nothing.

## Problem
When someone writes to Godspeed on Telegram in English and the draft reply was German, the translated reply can keep one or two German words: "Got it, I saved the Eintrag. How can you tell that it is fertig?". The language check (since #453) judges a reply by the share of language words, so a short reply with two German words passes. The code is `notebook/assistant-files/godspeed-reply/__init__.py`.

## Why
A reply that is partly in the wrong language reads as broken.

## Why now
It was reported after beta.23's language fix, and the maintainer's plan has decided the question #486 left open.

## Outcome
- For a reply of under 25 words, any word from the other language's word list that is not a known loanword makes the reply be translated once more. The loanwords are kept as an explicit list: Login, API, Tests, Update, Telegram and the like.
- Longer replies keep the share rule.
- If the second translation still carries such a word, it is sent as it is: no loop, no refusal.

## Invariants
- A loanword on the explicit list never triggers a second translation.
- At most one extra translation per reply.
- German replies to German messages are unchanged.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A test: the short reply from the problem above is translated again.
- A test: "Your Login and API Tests passed." is not.
- A test: a long reply with one German word follows the share rule as today.

## Done means
The tests exist and pass with the repository's tests.
