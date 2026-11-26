Ticket for 2.0.0-beta.24 (plan item 3). Size: full. Depends on: nothing.

## Problem
Pictures and PDFs added to the notebook stay on the computer they were added on.
- `starter-godspeed/.gitignore` keeps `.godspeed/`, media included, out of the private GitHub copy.
- The integrated runtime keeps media in `GODSPEED_MEDIA_ROOT` (`.godspeed/integrated-runtime/media` on Linux).
- Notes and the records of their attachments (`notebook/_system/note_attachments`, `media_analysis`) do travel. So another computer, or a new server, shows the records with broken files.
- Media sync (`notebook/core/sync/media.mjs`) works only between a server and the computers paired with it.

## Why
On 2026-11-13 the maintainer's media library on his new server showed no pictures or PDFs: the move carried the records of 43 files and none of the files. 41 were restored by hand and 2 are lost.

## Why now
It happened to the maintainer, and every user who adds a second computer or moves a server will meet it.

## Outcome
The maintainer's plan chose option 1 of the issue.
- Media is kept in the private GitHub copy beside the notes, as plain files in one folder under the notebook (for example `notebook/_media/`). Each file is named by its content hash plus the original extension, so the same file added twice is stored once. The existing mapping (original path to stored file, content type, size) travels with it.
- The notebook reads a file from that folder first and falls back to the old media root, so nothing breaks while a computer has not synced yet.
- On the first run after the update, every file in the old media root that a record still points to is copied into the new folder once. It then goes out with the next ordinary sync.
- A single file over 50 MB is not committed (GitHub refuses 100 MB). It stays in the old media root and the nightly backup, and the media library shows on that item that it is kept on this computer only.
- Server-and-computer media sync keeps working and simply finds the files already present.

## Invariants
- No media file is deleted from, or moved out of, the old media root by this change.
- Removing a picture (the existing `removed_at` on its mapping) still hides it everywhere.
- Notes, records and settings sync exactly as before, and the private copy stays private.
- Stored file names come only from content hashes and known extensions, never from the user's file name.
- Blocks: a finding that breaks the outcome, an invariant or the acceptance on a normal install (files as the installer writes them, read by the user it runs as), and any finding, on any install, that leads to an unsafe or outward action nobody approved. A fault that needs a damaged or hand-edited file, wrong permissions or a rare race, and whose worst effect is safe (a missed or late notice, an extra question, a visible failure), is written into the pull request as a limit and does not block.

## Acceptance
- A test: a picture saved through `/api/media/upload` lands in the new folder and is served by `/api/media/file/<path>`.
- A test: a second install that has only the notes folder, as a clone of the private copy would give it, serves the same picture.
- A test: the first-run step copies the existing media once, and a second run copies nothing.
- A test: a file over 50 MB stays local, and its library item says so.

## Done means
The tests above exist and pass with the repository's tests. The scenario that proves this across two installs needs a workflow job, which the factory cannot add, so it belongs to the release step. Describe in the pull request what that scenario should do.
