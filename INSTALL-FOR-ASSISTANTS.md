# Install

Run the public installer on the Godspeed server:

```bash
curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | bash
```

The installer requires Godspeed 2.0.0-beta.24 or newer. It installs the add-on and its setup skill;
it does not start a factory schedule.

It does enable `godspeed-forge-questions.timer` for the installing user. Every 15 minutes that timer
checks completed repository registrations for owner decisions. The command uses the configured
`godspeedRoot` notice and authenticated conversation records and the configured `modelCommand`; it
does not contact a separate chat service. State is stored privately as `questions.json` per project.
An owner answers with the notice's `Q-XXXXXX: answer` form. Invalid or unclear input fails closed and
does not create a GitHub comment.

# Set up a repository

When the owner says “set up the Forge for `owner/repository`”, use the installed `forge-setup`
skill. For each App, the owner identifies whether the repository owner is their personal account or
organization, completes the creation browser step in that location, follows the installation
link, chooses the requested account, selects “Only select repositories”, selects only the requested
repository, and confirm that installation to the command. They must also answer what the software
is for and who uses it. GitHub redirects each creation step to a local address; the owner pastes
that address back so the Forge can finish the exchange. Never ask them to paste credentials into
chat, and never say setup is complete before both repository installations and doctor succeed.
