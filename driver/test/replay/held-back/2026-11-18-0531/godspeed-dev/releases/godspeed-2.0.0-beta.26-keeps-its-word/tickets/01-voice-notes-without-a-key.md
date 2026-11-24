Ticket for 2.0.0-beta.26 (plan item 1). Size: full. Depends on: nothing (continues pull request #612). Repository: MichaelZelbel/godspeed-mission-control.

## Problem
On a native Linux install with no ElevenLabs key, every voice note sent to the assistant fails ("I couldn't transcribe that voice message automatically"), while Settings says voice notes are understood on this computer. Only the Docker candidate installs `faster_whisper`; the native installer did not. A fresh Hermes config also carries `stt.language: "en"`, so a German voice note is transcribed as English, with or without a key.

Pull request #612 now installs `faster-whisper==1.2.1` natively and its registered journey runs, but the journey fails at its own probe: `scenarios/local-voice-through-hermes.py` looks for `transcribe_local` or `_transcribe_local` in `tools.transcription_local`. That module holds only settings and model-loading helpers. Hermes's transcription functions are in `tools.transcription_tools`.

## Why
Settings promises something the install does not deliver, and a person who speaks German gets a wrong transcript.

## Why now
The maintainer found it on his own server on 2026-11-15. It was item 1 of beta.25 and reached the cap there only because the journey probed the wrong module.

## Owner decision
Decided 2026-11-15 by Mission Control as a question of how. The seam to exercise is Hermes's own public `tools.transcription_tools.transcribe_audio`, reading the installed config (`stt.provider: local`, or no provider so Hermes picks local), the same call a Telegram voice note makes through Hermes. The product's dictation keeps `transcribe_audio_local_fallback`, which `notebook/assistant-files/dictate.py` already uses. The journey must not probe private names (`_transcribe_local` and the like) or guess module names. Approved changes to what the journey judges: none looser; it must still fail when no transcript comes back or when a German note comes back in English.

## Outcome
- A native install (Linux; Windows too if it has the same gap, checked in `windows/`) installs the local transcriber, so a voice note is understood with no key, as Settings says. If a platform cannot get it, Settings says plainly that voice notes need a key there.
- Godspeed leaves `stt.language` blank (auto-detect) on install and whenever it switches transcription on or saves a key, and clears an `"en"` an older install wrote on its first run after the update, unless the person chose a language in Settings.

## Invariants
- An install with an ElevenLabs key keeps using ElevenLabs.
- The voice note permission keeps working ("a voice note, with the permission and without it" still passes).
- No new network service is exposed; the transcriber runs locally.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- The registered journey, through `tools.transcription_tools.transcribe_audio` on a fresh native Linux install with no key, returns the words of a voice note, and a German voice note in German.
- The installed permission and no-permission voice journey passes on the same head.
- Unit tests for the language setting: blank on a fresh install, an inherited "en" cleared once, a language the person chose kept.
- Settings' text matches what the install can do, tested.

## Done means
The installer change, the language handling, the corrected journey and the tests exist and pass with the repository's tests.
