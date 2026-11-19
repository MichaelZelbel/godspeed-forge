#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 5

test_case "the installer requires Godspeed 2.0.0-beta.24"
grep -q 'MINIMUM_GODSPEED="2.0.0-beta.24"' install.sh
temporary="$(mktemp -d)"
trap 'test_cases_end; rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM

test_case "an older Godspeed is refused and nothing is installed"
if GODSPEED_VERSION=2.0.0-beta.23 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/old" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out" 2>"$temporary/error"; then
  echo 'older Godspeed was accepted' >&2
  exit 1
fi
grep -q 'Godspeed 2.0.0-beta.23 is installed; the Forge requires Godspeed 2.0.0-beta.24 or newer.' "$temporary/error"
test ! -e "$temporary/old"

test_case "the exact minimum Godspeed installs the Forge, its command and the setup skill"
mkdir -p "$temporary/workspace"
GODSPEED_VERSION=2.0.0-beta.24 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/exact" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out"
test -f "$temporary/exact/addon/bin/godspeed-forge.mjs"
test -L "$temporary/exact/bin/godspeed-forge"
test ! -e "$temporary/exact/addon/factory"
test -f "$temporary/workspace/skills/forge-setup/SKILL.md"
test_case "the installed config has defaults and no private settings"
test -f "$temporary/exact/config.json"
grep -q 'projectsRoot' "$temporary/exact/config.json"
if grep -Eqi 'token|secret|private.?key|app.?id' "$temporary/exact/config.json"; then echo 'the installed config holds a private setting' >&2; exit 1; fi
test_case "installing again keeps the owner's config"
printf '{"owner":"kept"}\n' > "$temporary/exact/config.json"
GODSPEED_VERSION=2.0.0-beta.24 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/exact" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >/dev/null
grep -q '"owner":"kept"' "$temporary/exact/config.json"
