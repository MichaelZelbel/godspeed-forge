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
version `1cfb8fc5` plus three changes. Building runs on the medium tier. A comment headed `Manager decision
(Mission Control, not Michael)` carries the owner's authority for technical matters only. What the loop finds
beyond its own job goes as one `Found:` comment onto a `found-list` issue instead of a new issue each. See the
[difference](https://github.com/MichaelZelbel/Archon/compare/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb...6ebb22b66803cf0fca1f185e65e49afe792e4075).

# Set up a repository

Setup runs in the server's terminal, as root: `godspeed-forge setup owner/repository`. When the owner
asks for it in the chat, the `forge` skill tells them that line. For each App, the owner identifies whether the repository owner is their personal account or
organization, completes the creation browser step in that location, follows the installation
link, chooses the requested account, selects “Only select repositories”, selects only the requested
repository, and confirm that installation to the command. They must also answer what the software
is for and who uses it. GitHub redirects each creation step to a local address; the owner pastes
that address back so the Forge can finish the exchange. Never ask them to paste credentials into
chat, and never say setup is complete before both repository installations and doctor succeed.

# The page where the owner watches the factory

The install line also sets up the page where the owner watches the factory at work (every project, every run and each
step of a run), or brings it up to date, and prints its address. Setup ends with the address and the sign-in, in the
form "Watch the factory at https://<name>:<port>. Sign in as forge with the password <password>; keep both in your
password manager." Running the install line or setup again keeps the sign-in. Never ask the owner for the password and
never put it into the chat; when they no longer have it, they type `godspeed-forge watch` in the server's terminal, as
root, which shows the address and the sign-in again. When the page does not open from outside although setup gave its
address, a firewall the hosting company runs in front of the server must let that port in (48445 unless setup named
another). When setup could not set the page up, it said why in one sentence; `godspeed-forge watch` tries again.
