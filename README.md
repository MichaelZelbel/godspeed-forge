# The Forge

An add-on for [Godspeed Mission Control](https://github.com/MichaelZelbel/godspeed-mission-control).

Install it on a Godspeed server with:

```bash
curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | bash
```

The Forge gives anyone who has Godspeed and a GitHub project a whole development process:

- you plan a release in one sentence ("plan release my-app"),
- [Cole Medin's AI software factory](https://github.com/coleam00/ai-software-factory) builds it,
  one ticket at a time,
- the questions only you can answer reach your chat in plain words,
- a finished release lands on your staging copy by itself,
- and your "go" makes it public, while "take it back" returns the version before.

## How it relates to Cole Medin's factory

The Forge does not contain Cole Medin's factory and never changes it. His repository carries no
license, so his code is not ours to hand out. The Forge installs his factory from his own repository
at one pinned revision, the way his README asks a coding agent to, and everything the Forge adds
(planning, the questions, staging, the go and take-back) sits beside it.

## Status

Ask Godspeed to “set up the Forge for `owner/repository`”. Setup uses a signed-in Claude Code or
Codex account, installs the pinned factory, guides you through creating separate builder and release
GitHub Apps, asks the two mission questions, and reports the factory doctor. It leaves the schedule
off until you explicitly start it.

Non-root installs use `~/.godspeed/forge/config.json` for defaults and
`~/.godspeed/forge/state/` for private state. Root Linux installs use
`/etc/godspeed-forge/config.json` and `/var/lib/godspeed/forge/`. The state directories are mode
0700 and credential files are mode 0600. The defaults are the projects directory, Claude-before-
Codex agent order, a plain cost notice, and the `git`, `gh`, and `python3` command names. The config,
project checkout, and setup output never contain App credentials or ids.

The builder App has repository permissions for Contents, Pull requests, Issues, and Actions
read/write, plus Checks, Commit statuses, and Metadata read. The release App has Contents and Pull
requests read/write, plus Checks, Actions, and Metadata read. Neither App receives organization,
Administration, Secrets, Members, Workflows, environment-secret, or Deployment permission.

## License

MIT, see [LICENSE](LICENSE). This covers the Forge's own files only, not Cole Medin's factory or
Archon, which the Forge downloads from their own repositories.
