# Install

Run the public installer on the Godspeed server:

```bash
curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | bash
```

The installer requires Godspeed 2.0.0-beta.24 or newer. It installs the add-on and its setup skill;
it does not start a factory schedule.

# Set up a repository

When the owner says “set up the Forge for `owner/repository`”, use the installed `forge-setup`
skill. The owner must complete the two GitHub App browser steps and answer what the software is for
and who uses it. GitHub redirects each browser step to a local address; the owner pastes that
address back so the Forge can finish the exchange. Never ask them to paste credentials into chat.
