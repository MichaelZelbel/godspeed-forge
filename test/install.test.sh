#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."

grep -q 'MINIMUM_GODSPEED="2.0.0-beta.24"' install.sh
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

if GODSPEED_VERSION=2.0.0-beta.23 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/old" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out" 2>"$temporary/error"; then
  echo 'older Godspeed was accepted' >&2
  exit 1
fi
grep -q 'Godspeed 2.0.0-beta.23 is installed; the Forge requires Godspeed 2.0.0-beta.24 or newer.' "$temporary/error"
test ! -e "$temporary/old"

mkdir -p "$temporary/workspace"
GODSPEED_VERSION=2.0.0-beta.24 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/exact" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out"
test -f "$temporary/exact/addon/bin/godspeed-forge.mjs"
test -L "$temporary/exact/bin/godspeed-forge"
test ! -e "$temporary/exact/addon/factory"
test -f "$temporary/workspace/skills/forge-setup/SKILL.md"
test -f "$temporary/exact/config.json"
grep -q 'projectsRoot' "$temporary/exact/config.json"
grep -q 'godspeedRoot' "$temporary/exact/config.json"

# Exercise the public install path without FORGE_SOURCE. The curl stand-in records the default
# delivery URL and supplies an archive of this reviewed tree, just as GitHub does for the pull ref.
mkdir -p "$temporary/public-bin"
git archive --format=tar.gz --prefix=godspeed-forge/ HEAD >"$temporary/public.tar.gz"
printf '%s\n' '#!/usr/bin/env bash' 'set -eu' \
  'test "$1" = "-fsSL"' \
  'test "$2" = "https://github.com/MichaelZelbel/godspeed-forge/archive/refs/pull/18/head.tar.gz"' \
  'test "$3" = "-o"' \
  'cp "$FORGE_TEST_ARCHIVE" "$4"' >"$temporary/public-bin/curl"
chmod +x "$temporary/public-bin/curl"
PATH="$temporary/public-bin:$PATH" FORGE_TEST_ARCHIVE="$temporary/public.tar.gz" \
  GODSPEED_VERSION=2.0.0-beta.24 FORGE_INSTALL_ROOT="$temporary/public" \
  GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/public-out"
test -f "$temporary/public/addon/lib/questions/relay.mjs"
test -f "$temporary/public/systemd/godspeed-forge-questions.service"
grep -q 'OnUnitInactiveSec=15min' "$temporary/public/systemd/godspeed-forge-questions.timer"
grep -q ' questions' "$temporary/public/systemd/godspeed-forge-questions.service"
"$temporary/public/bin/godspeed-forge" questions 2>"$temporary/public-questions-error" || true
! grep -q 'Run godspeed-forge setup owner/repository.' "$temporary/public-questions-error"
grep -q 'The Forge is installed.' "$temporary/public-out"
grep -q 'OnUnitInactiveSec=15min' "$temporary/exact/systemd/godspeed-forge-questions.timer"
grep -q ' questions' "$temporary/exact/systemd/godspeed-forge-questions.service"
! grep -Eqi 'token|secret|private.?key|app.?id' "$temporary/exact/config.json"
printf '{"owner":"kept"}\n' > "$temporary/exact/config.json"
GODSPEED_VERSION=2.0.0-beta.24 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/exact" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >/dev/null
grep -q '"owner": "kept"' "$temporary/exact/config.json"
grep -q 'godspeedRoot' "$temporary/exact/config.json"
