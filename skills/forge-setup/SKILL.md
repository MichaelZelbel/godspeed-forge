---
name: forge-setup
description: Set up the Forge when the owner asks to set it up for an owner/repository.
---

# Set up the Forge

Extract only the `owner/repository` name from the owner's request. Run:

```bash
godspeed-forge setup owner/repository
```

Relay the command's messages exactly. For each GitHub App, let the owner choose the repository
owner's personal or organization registration location, create it there, follow its
installation link, choose the requested account, select “Only select repositories”, select only
the requested repository, and confirm the installation. Let the owner answer the two mission
questions. Do not request or repeat a key, token, App id, or private key, and do not report setup
complete before both repository installations and the setup checks succeed. App credentials stay in
the private credentials subtree; project state contains only non-secret setup records.

When a stop asks the owner to ask you to start a saved file afresh and the owner does, run setup again
for the same repository with `--start-afresh` and the part that phrase names, for example:

```bash
godspeed-forge setup owner/repository --start-afresh builder-app
```

| The stop asks to start … afresh | Part |
| --- | --- |
| the Forge's settings | `settings` |
| the project's mission file | `mission` |
| setup's list of GitHub Apps | `app-list` |
| the builder App's saved details | `builder-app` |
| the release App's saved details | `release-app` |
| the saved details of both Apps | `both-apps` |
| connecting the builder App | `builder-connection` |
| connecting the release App | `release-connection` |

Setup then replaces only that file, and only when it still cannot read it. Never pass `--start-afresh`
unless the owner asked for it after such a stop, and never delete a file on the server instead.

After the Forge is upgraded, run setup again for each repository that was set up by an earlier release.
That setup run moves its existing App credentials from project state into the private credentials subtree.
