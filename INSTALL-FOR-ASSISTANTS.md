# Install

Run the public installer on the Godspeed server:

```bash
curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | bash
```

The line installs the newest Forge release, never the newest code on main; `FORGE_VERSION=v0.1.0` before `bash` picks a specific release.

Run it as root, on a server where Godspeed runs natively or in Docker. The installer requires
Godspeed 2.0.0-beta.24 or newer, installs what the factory needs on the server (git, `gh`, Python 3.10
or newer, Node 22, bun, uv, Claude Code and Codex), installs the add-on, gives Godspeed's chat the
`forge` skill and starts the service that answers the chat's requests. It does not start a factory
schedule.

The Forge installs Cole Medin's AI software factory with his installer. The Archon code it runs comes from
[a public copy of his](https://github.com/MichaelZelbel/Archon), under his MIT license with his name: his
version `1cfb8fc5` plus five changes. Building runs on the medium tier. A comment headed `Manager decision
(Mission Control, not Michael)` carries the owner's authority for technical matters only, and one headed `Manager
decision (Mission Control, on Michael's standing instruction` settles product, scope, look and feel and behaviour too. What the loop finds
beyond its own job goes as one `Found:` comment onto a `found-list` issue instead of a new issue each. The tickets of an approved release (labelled `priority`) are worked first, and the next item is chosen in code, not by an AI reading a prompt. See the
[difference](https://github.com/MichaelZelbel/Archon/compare/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb...ddc9835236f9aa1b04daa45ac3ea812d63484723).

# Set up a repository

The owner sets up in the chat: "set up the Forge for owner/repository" is a `setup` request (see the `forge` skill), and the
Forge answers each step in plain words: the sign-in links and codes for GitHub and Codex, a link for each of the two GitHub
Apps (GitHub sends the owner's browser back to the watch page's address, so nothing is pasted), the purpose and users it read
from the project to confirm, the numbered list of what the project must never become, and a yes before anything is pushed.
Claude Code's own sign-in is the one step that stays in the server's terminal, because its code must never be typed into a chat.
This needs the watch page to be set up and current: when it is not, the Forge says to run `godspeed-forge watch` once as root.
`godspeed-forge setup owner/repository` in the server's terminal, as root, does the same without the chat and is unchanged;
there GitHub redirects each creation step to a local address and the owner pastes it back. Never ask the owner to paste
credentials or a sign-in code into chat, and never say setup is complete before both repository installations and doctor succeed.

# The page where the owner watches the factory

The install line also sets up the page where the owner watches the factory at work (every project, every run and each
step of a run), or brings it up to date, and prints its address. Setup ends with the address and the sign-in, in the
form "Watch the factory at https://<name>:<port>. Sign in as forge with the password <password>; keep both in your
password manager." Running the install line or setup again keeps the sign-in. Never ask the owner for the password and
never put it into the chat; when they no longer have it, they type `godspeed-forge watch` in the server's terminal, as
root, which shows the address and the sign-in again. When the page does not open from outside although setup gave its
address, a firewall the hosting company runs in front of the server must let that port in (48445 unless setup named
another). When setup could not set the page up, it said why in one sentence; `godspeed-forge watch` tries again.
