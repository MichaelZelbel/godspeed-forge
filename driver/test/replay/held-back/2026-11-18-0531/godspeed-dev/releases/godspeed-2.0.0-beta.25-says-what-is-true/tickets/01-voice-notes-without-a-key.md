Status: done (merge dac8af34304de6a84cddb558d0199e851f181e60)

Ticket for 2.0.0-beta.25 (plan item 1). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control.

## Problem
On a native Linux install with no ElevenLabs key, every voice note sent to the assistant on Telegram fails: the reply is "I couldn't transcribe that voice message automatically" and the gateway log says no speech-to-text provider is available. Settings at the same time tells the person their voice notes are understood on this computer (`notebook/core/voice-speech.mjs`, `transcribeStatus` in `notebook/core/voice-replies.mjs`), and `docs/chat-design.md` relies on Hermes's local faster-whisper backend. Only the Docker candidate installs and checks `faster_whisper` (`docker/full-candidate/test.sh`); the native installer (`install-godspeed.sh`) never does. Separately, a fresh Hermes config carries `stt.language: "en"`, which Hermes passes as the language hint to every provider (ElevenLabs Scribe included), so a German voice note is transcribed as if it were English.

## Why
Settings promises something the install does not deliver, and a person who speaks German gets a wrong transcript even with a paid key.

## Why now
Found by the maintainer on his own server on 2026-11-15: voice notes failed from the server move on 10 November until he saved an ElevenLabs key.

## Outcome
- A native install (Linux; Windows too if it has the same gap, checked in `windows/`) installs the local transcriber the way the Docker candidate does, so a voice note is understood with no key, as Settings says. If a platform cannot get it, Settings says plainly that voice notes need a key there instead of promising them.
- Godspeed leaves `stt.language` blank (auto-detect) on install and whenever it switches transcription on or saves a key, and clears an `"en"` an older install wrote on its first run after the update, unless the person set a language themselves in Settings.

## Invariants
- An install with an ElevenLabs key keeps using ElevenLabs.
- The voice note permission keeps working as today ("a voice note, with the permission and without it" still passes).
- No new network service is exposed; the transcriber runs locally.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The scenario "a voice note, with the permission and without it" is extended (or a sibling added) so that on a fresh native Linux install with no key a voice note comes back as words, and a German voice note comes back in German.
- Unit tests for the language setting: blank on a fresh install, an inherited "en" cleared once, a language the person chose kept.
- Settings' text matches what the install can do, tested.

## Done means
The installer change, the language handling and the tests exist and pass with the repository's tests.
