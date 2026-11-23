# The Forge

An add-on for [Godspeed Mission Control](https://github.com/MichaelZelbel/godspeed-mission-control).

Install it on a Godspeed server, as root, with:

```bash
curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | bash
```

The line installs the newest Forge release, never the newest code on main; `FORGE_VERSION=v0.2.0` before `bash` picks a specific release. It works with Godspeed in Docker (the server from Godspeed's one-line installer) and with a native install, puts on the server everything the factory needs (git, GitHub's `gh`, Python, Node 22, bun, uv, Claude Code and Codex) and gives Godspeed's chat a Forge skill. Then type `godspeed-forge setup owner/repository` in the same terminal.

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

The Forge installs Cole Medin's AI software factory with his installer. The Archon code it runs comes from
[a public copy of his](https://github.com/MichaelZelbel/Archon), under his MIT license with his name: his
version `1cfb8fc5` plus three changes. Building runs on the medium tier. A comment headed `Manager decision
(Mission Control, not Michael)` carries the owner's authority for technical matters only. What the loop finds
beyond its own job goes as one `Found:` comment onto a `found-list` issue instead of a new issue each. See the
[difference](https://github.com/MichaelZelbel/Archon/compare/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb...6ebb22b66803cf0fca1f185e65e49afe792e4075).

## Status

Type `godspeed-forge setup owner/repository` in the server's terminal, as root (asked in the chat, Godspeed gives you that line). Before it downloads anything, setup signs the
server in to GitHub (with permission to change workflow files) and to Claude Code or Codex when either is
missing, showing the link and code of each tool's own sign-in, and reuses sign-ins that already work. It installs
the pinned factory, guides you through creating separate builder and release
GitHub Apps in the repository owner's personal or organization account, then guides you to install each App only on that repository. Setup asks the two mission
questions, then finishes the factory's own setup: it sets the factory's AI models for the coding assistant it
found, has that assistant read the project and propose seven things it must never become (you strike the
wrong ones by number), writes two to five journeys of what the project does today and the project's checks,
shows you what it will add and, on your yes, pushes these files to the default branch (or, where the branch takes
changes only through a pull request, pushes them to a new branch of their own and opens and merges one). The
assistant may write only the journeys and the checks: every other file of the factory is put back as it was after
it runs. It reports the setup checks. It completes only after both installations are confirmed
and the checks succeed, and it leaves automatic work off until you say "plan release" with the project's name,
then "run one lap" and then "turn on automatic work" in your chat; "pause the factory" stops it starting new work.
Only one setup
per repository runs at a time; asking again while one is running says so and changes nothing.
Asking for setup again after it completed checks that both Apps are still on GitHub and installed on
the repository, that their saved details are still on this server and that the project's build tools
are still in place; when something is missing it says what, instead of reporting the repository set up.
It also checks that the project's mission is still in `MISSION.md` and that the final check still passes;
when either is not, it sets the project up again with the same Apps and saved mission answers, asking
nothing, and either completes or stops the way a first setup would.

Non-root installs use `~/.godspeed/forge/config.json` for defaults and
`~/.godspeed/forge/state/` for private state. Root Linux installs use
`/etc/godspeed-forge/config.json` and `/var/lib/godspeed/forge/`. The state directories are mode
0700 and credential files under the private `credentials/` subtree are mode 0600. Project state
contains only non-secret setup records. The defaults are the projects directory, a plain release-cost estimate,
and the `git`, `gh`, and `python3` command names. The config and setup output never contain App
credentials or ids, and the project checkout never contains App credentials.

Setup keeps a list of the GitHub Apps it made for a repository, with each App's role, name, slug and id
and never a key, in that repository's project checkout at `.git/godspeed-forge-apps.json`, which git never
commits or pushes. The list outlasts the private state being lost or restored from an older copy. Before
setup creates an App, it asks GitHub, through this server's `gh` sign-in, about the App the list names for
that role; when that App is still on GitHub but this server can no longer use it, setup creates nothing and
stops, naming the App to delete. Before setup uses an App whose details or keys this server holds, it also
asks GitHub whether that App is still there and installed, so a deleted App is created again and an
uninstalled one is installed again instead of being reported as set up. When GitHub cannot be reached or
refuses either question, setup changes nothing and stops, and the next run asks again.

After upgrading a server that set up repositories with an earlier release, run setup again for each
repository. That setup run moves its existing App credentials out of project state and into the private
credentials subtree.

The builder App has repository permissions for Contents, Pull requests, Issues, and Actions read/write, plus Checks, Commit statuses, and Metadata read. The release App has repository permissions for Contents and Pull requests read/write, plus Checks, Actions, and Metadata read. Neither App receives organization,
Administration, Secrets, Members, Workflows, environment-secret, or Deployment permission.

## The factory driver

The factory driver keeps the factory and every approved release moving without you: it notices work that has
stopped, starts a fixed number of AI helpers to unstick it, and tells you only what truly needs you, once, in plain
words. A small keeper puts the last good version back when an update goes wrong, and a dead-man watches the driver
from outside, so each can repair the other. The jobs that used to run on timers of their own (checking who may decide,
asking you the product questions, watching that the hidden checks can run, keeping main green, planning and staging
releases) are now steps of the driver.

Setup installs it when it finishes as root on a Linux server with systemd. You can also install or upgrade it any
time with `godspeed-forge driver install` (add `--switch` to turn off the older timers it replaces; they are switched
off, never deleted, and `--watcher` puts the outside watcher into its GitHub repository). `godspeed-forge driver
round --dry-run` shows what the driver would do and changes nothing, and `godspeed-forge driver status` says how it is.

Its settings are two kinds of file in one folder (root Linux: `/etc/godspeed-forge/`): `driver.json` for the server, and
one `projects/<owner>--<repository>.json` for each repository. `driver/settings.example.json` shows every setting with
placeholders. The install checks them and names anything missing before it changes anything. When a server has no
`driver.json` yet, setup writes one for its new owner: only the steps that work for any owner are on, the driver starts
no AI runs of its own, and its notices go to the owner's Godspeed. A `driver.json` that is already there is never
written over.

## For every owner

Once a repository is set up, you talk to the Forge in your Godspeed chat. Two steps of the driver, `owner-questions`
and `owner-releases`, run every 15 minutes for each repository set up with the Forge, and your chat hands your words to
the Forge through files in your Godspeed workspace (`.godspeed/forge/`).

- **Plan:** "plan release my-app" proposes one release in plain words, from what is wrong for the people using it
  first, then what you found, then features. On your yes the Forge files each item as an issue through the builder App,
  where Cole Medin's factory picks it up, and keeps the plan and which issue is which item on this server.
- **Questions:** when the factory needs a decision only you can make, you get it once in your chat, with a short
  handle (F1, F2, ...), an example, one sentence per choice, what happens if you do not answer, and the words to reply
  with. Questions of how it is built stay with the factory. Your answer goes back to the factory in your own words.
- **Staging:** when every item of the release is merged, the Forge freezes it as `candidate/<version>`, pauses the
  factory while the project's own checks run on it, makes a GitHub pre-release to try, moves the branch `staging` to it
  and sends you one message: the link and "Shall I make it public? Reply go.", or the checks that failed.
- **Go:** "go" tags `v<version>` on exactly that candidate, makes it the latest GitHub release with the plan's
  sentences as its notes, and moves the branch `live` to it. A go for a candidate that changed after it was put up to
  try is refused.
- **Take it back:** "take it back" makes the release before it the latest again, moves `live` back, and marks the
  taken-back release as taken back. Nothing is ever deleted.
- **Release status:** "release status" answers in one or two sentences: what is being built, what waits for you, what
  is on staging and what is public.

A hosting service that publishes from a branch can publish a staging copy from `staging` and your public site from
`live`; `live` then always shows exactly the version you made public. Tags, releases and these two branches are moved
by the release App. The one exception: GitHub lets an App move a branch over a change to the project's workflow files
only with the Workflows permission, which neither Forge App has, so that one move is made with this server's own `gh`
sign-in (setup signs it in with the `workflow` scope).

None of this needs a setting. A project can add a profile in its driver settings file
(`projects/<owner>--<repository>.json`): `"profile": { "staging_url": "...", "deploy": "...", "health": "..." }`, where
`staging_url` is the link you get instead of the pre-release's page, `deploy` puts the candidate on your staging copy
after `staging` moved, and `health` must then succeed and print the candidate's commit. The steps' other settings, all
optional, are in `driver/settings.example.json`.

## License

MIT, see [LICENSE](LICENSE). This covers the Forge's own files only, not Cole Medin's factory or
Archon, which the Forge downloads from their own repository and from the public copy of Archon linked above.
