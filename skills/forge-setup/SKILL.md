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
complete before both repository installations and doctor succeed.
