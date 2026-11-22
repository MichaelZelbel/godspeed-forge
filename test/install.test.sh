#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 13

# No case asks a real Godspeed: its health answer is asked where nothing listens.
export GODSPEED_HEALTH_URL="http://127.0.0.1:9/health"
next_step="Next, type godspeed-forge setup owner/repository here, with your own GitHub project in place of owner/repository."

test_case "the installer requires Godspeed 2.0.0-beta.24"
grep -q 'MINIMUM_GODSPEED="2.0.0-beta.24"' install.sh
temporary="$(mktemp -d)"
trap 'test_cases_end; rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM

test_case "an older Godspeed is refused in one plain sentence and nothing is installed"
if GODSPEED_VERSION=2.0.0-beta.23 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/old" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out" 2>"$temporary/error"; then
  echo 'older Godspeed was accepted' >&2
  exit 1
fi
test "$(cat "$temporary/error")" = "Godspeed 2.0.0-beta.23 is installed; the Forge requires Godspeed 2.0.0-beta.24 or newer. Update Godspeed, then run this line again."
test ! -s "$temporary/out"
test ! -e "$temporary/old"

test_case "the exact minimum Godspeed installs the Forge, its command and the forge skill"
mkdir -p "$temporary/workspace"
GODSPEED_VERSION=2.0.0-beta.24 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/exact" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out"
test -f "$temporary/exact/addon/bin/godspeed-forge.mjs"
test -f "$temporary/exact/addon/lib/godspeed.mjs"
test -L "$temporary/exact/bin/godspeed-forge"
test ! -e "$temporary/exact/addon/factory"
cmp skills/forge/SKILL.md "$temporary/workspace/skills/forge/SKILL.md"
test ! -e "$temporary/workspace/skills/forge-setup"
test -d "$temporary/workspace/.godspeed/forge/inbox/done"
test -d "$temporary/workspace/.godspeed/forge/outbox"

test_case "the install says each step in one plain line and ends with the one next step"
printf '%s\n' "Found Godspeed 2.0.0-beta.24 on this server." \
  "Not running as root, so the server's tools and services were left as they are." \
  "Installing the Forge $(cat VERSION)." \
  "Godspeed's chat now knows the Forge." \
  "The Forge is installed." \
  "$next_step" > "$temporary/expected"
diff "$temporary/expected" "$temporary/out"

test_case "the installed config has defaults and no private settings"
test -f "$temporary/exact/config.json"
grep -q 'projectsRoot' "$temporary/exact/config.json"
if grep -Eqi 'token|secret|private.?key|app.?id' "$temporary/exact/config.json"; then echo 'the installed config holds a private setting' >&2; exit 1; fi

test_case "installing again keeps the owner's config and the setup skill an earlier release left goes"
printf '{"owner":"kept"}\n' > "$temporary/exact/config.json"
mkdir -p "$temporary/workspace/skills/forge-setup"
printf -- '---\nname: forge-setup\ndescription: Set up the Forge when the owner asks to set it up for an owner/repository.\n---\n\nRun godspeed-forge setup owner/repository\n' > "$temporary/workspace/skills/forge-setup/SKILL.md"
GODSPEED_VERSION=2.0.0-beta.24 FORGE_SOURCE="$PWD" FORGE_INSTALL_ROOT="$temporary/exact" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >/dev/null
grep -q '"owner":"kept"' "$temporary/exact/config.json"
test ! -e "$temporary/workspace/skills/forge-setup"
test -f "$temporary/workspace/skills/forge/SKILL.md"

# A stand-in curl: the release lookup answers from $FAKE_RELEASE (empty: GitHub has no release), the archive
# download serves $FAKE_ARCHIVE, and every address asked is written to $FAKE_LOG.
mkdir -p "$temporary/fake" "$temporary/pack" "$temporary/pack-self"
cat > "$temporary/fake/curl" <<'CURL'
#!/usr/bin/env bash
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "$url" >> "$FAKE_LOG"
case "$url" in
  */releases/latest) if [ -n "${FAKE_RELEASE:-}" ]; then echo "{\"tag_name\": \"$FAKE_RELEASE\"}"; else echo '{"message":"Not Found"}'; fi ;;
  *.tar.gz) cp "$FAKE_ARCHIVE" "$out" ;;
  *) exit 22 ;;
esac
CURL
chmod +x "$temporary/fake/curl"
# The Forge without its own installer, as a release archive; and one whose installer only says it ran.
mkdir "$temporary/pack/godspeed-forge-x"
cp -R bin lib skills driver README.md INSTALL-FOR-ASSISTANTS.md LICENSE VERSION "$temporary/pack/godspeed-forge-x/"
tar -czf "$temporary/forge.tar.gz" -C "$temporary/pack" godspeed-forge-x
mkdir "$temporary/pack-self/godspeed-forge-y"
cp -R bin lib skills driver README.md INSTALL-FOR-ASSISTANTS.md LICENSE VERSION "$temporary/pack-self/godspeed-forge-y/"
printf '#!/usr/bin/env bash\necho "the release installer ran with ${FORGE_NODE:+a Node and }the source in ${FORGE_SOURCE##*/}"\n' > "$temporary/pack-self/godspeed-forge-y/install.sh"
tar -czf "$temporary/forge-self.tar.gz" -C "$temporary/pack-self" godspeed-forge-y
export FAKE_ARCHIVE="$temporary/forge.tar.gz" FAKE_LOG="$temporary/curl.log"
release_install() {
  : > "$FAKE_LOG"
  PATH="$temporary/fake:$PATH" GODSPEED_VERSION=2.0.0-beta.24 FORGE_INSTALL_ROOT="$1" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh
}

test_case "the install line asks GitHub for the newest release and downloads that tag, never main"
FAKE_RELEASE=v0.1.0 release_install "$temporary/rel" >"$temporary/out"
grep -q 'api.github.com/repos/MichaelZelbel/godspeed-forge/releases/latest' "$FAKE_LOG"
grep -q 'godspeed-forge/archive/refs/tags/v0.1.0.tar.gz' "$FAKE_LOG"
if grep -q 'heads/main' "$FAKE_LOG"; then echo 'the installer downloaded main' >&2; exit 1; fi
test -f "$temporary/rel/addon/bin/godspeed-forge.mjs"
test "$(tail -n 1 "$temporary/out")" = "$next_step"
test_case "FORGE_VERSION picks a specific release without asking which is newest"
FORGE_VERSION=v0.0.9 FAKE_RELEASE=v0.1.0 release_install "$temporary/pinned" >"$temporary/out"
grep -q 'archive/refs/tags/v0.0.9.tar.gz' "$FAKE_LOG"
if grep -q 'releases/latest' "$FAKE_LOG"; then echo 'the installer asked for the newest release' >&2; exit 1; fi
test_case "FORGE_VERSION wins over an archive address left in the environment"
FORGE_VERSION=v0.0.8 FORGE_ARCHIVE_URL="http://127.0.0.1:9/elsewhere.tar.gz" release_install "$temporary/both" >"$temporary/out"
grep -q 'archive/refs/tags/v0.0.8.tar.gz' "$FAKE_LOG"
if grep -q 'elsewhere' "$FAKE_LOG"; then echo 'the archive address won over the named release' >&2; exit 1; fi
test_case "with no release on GitHub the installer stops in one plain sentence and installs nothing"
if FAKE_RELEASE= release_install "$temporary/none" >"$temporary/out" 2>"$temporary/error"; then echo 'installed without a release' >&2; exit 1; fi
test "$(cat "$temporary/error")" = "The Forge could not find its newest release on GitHub, so nothing was installed: GitHub did not answer or has no release yet. Try again in a minute, or name a release with FORGE_VERSION=<tag>."
test ! -e "$temporary/none"
if grep -q 'tar.gz' "$FAKE_LOG"; then echo 'the installer fell back to an archive' >&2; exit 1; fi
test_case "a release that has its own installer installs itself with it, given the Node found here"
FAKE_ARCHIVE="$temporary/forge-self.tar.gz" FAKE_RELEASE=v9.9.9 release_install "$temporary/self" >"$temporary/out"
test "$(cat "$temporary/out")" = "the release installer ran with a Node and the source in godspeed-forge-y"
test ! -e "$temporary/self"
test_case "Godspeed is also found in ~/.local/bin when it is not on PATH"
mkdir -p "$temporary/home/.local/bin"
printf '#!/usr/bin/env bash
echo "godspeed 2.0.0-beta.24"
' > "$temporary/home/.local/bin/godspeed"
chmod +x "$temporary/home/.local/bin/godspeed"
HOME="$temporary/home" PATH="$temporary/fake:$PATH" FAKE_RELEASE=v0.1.0 FORGE_INSTALL_ROOT="$temporary/home-install" GODSPEED_WORKSPACE="$temporary/workspace" bash install.sh >"$temporary/out"
test -f "$temporary/home-install/addon/bin/godspeed-forge.mjs"
test_case "the installed add-on knows its version"
test "$(cat "$temporary/rel/addon/VERSION")" = "$(cat VERSION)"
test "$(node "$temporary/rel/addon/bin/godspeed-forge.mjs" --version)" = "godspeed-forge $(cat VERSION)"
