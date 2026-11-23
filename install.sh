#!/usr/bin/env bash
# The Forge's install line, for a server that runs Godspeed Mission Control, natively or in Docker:
#
#   curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | bash
#
# Run it as root. It installs the newest Forge release, never the newest code on main; FORGE_VERSION=<tag> picks a
# release (and wins over FORGE_ARCHIVE_URL, which takes the Forge from another address). The release's own copy of
# this file then does the installing, so every release is installed the way it was made to be.
#
# What it does (lib/install/server.mjs has the rest):
#   1. finds a Node 22 or newer: the server's own, the one Godspeed's installer or Hermes brought, or, on Godspeed's
#      Docker server, a copy of the one inside Godspeed's container, kept in a temporary folder for this run;
#   2. finds Godspeed and checks its version through Godspeed's own health answer, and stops in one plain sentence
#      before installing anything when Godspeed is missing, not running or older than the Forge needs;
#   3. installs on the server whatever the factory needs and is missing (git, GitHub's gh, Python 3.10 or newer, Node 22,
#      bun, uv, Claude Code and Codex), saying each in one line;
#   4. installs the Forge, gives Godspeed's chat the forge skill, and starts the service that answers the chat;
#   5. where this server already has the factory driver's settings, brings the driver up to date as well.
# Running it again updates the Forge and keeps every setting.
#
# Everything sits inside functions and the last line calls main, so bash has read the whole file before anything runs,
# even under "curl | bash".
set -eu

MINIMUM_GODSPEED="2.0.0-beta.24"
NONE_FOUND="The Forge needs Godspeed Mission Control on this server, and none was found. Install Godspeed first, then run this line again."
UNPACK_FAILED="The Forge's download could not be unpacked, so nothing was installed. Run this line again in a few minutes."
NEXT_STEP="Next, type godspeed-forge setup owner/repository here, with your own GitHub project in place of owner/repository."

say() { printf '%s\n' "$*"; }
stop() { printf '%s\n' "$*" >&2; exit 1; }

# The major version of the Node at $1, or nothing.
node_major() { "$1" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || true; }
usable_node() {
  local major
  [ -n "$1" ] && [ -x "$1" ] || return 1
  major="$(node_major "$1")"
  [ -n "$major" ] && [ "$major" -ge 22 ]
}

# GODSPEED_DIR=... in the .godspeed/device.env of the home $1.
device_dir() { sed -n 's/^[[:space:]]*GODSPEED_DIR=//p' "$1/.godspeed/device.env" 2>/dev/null | head -n 1 | tr -d "\"'" || true; }

# A Node 22 or newer already on this server: FORGE_NODE, the PATH, the usual places, the copy an earlier run kept, the
# one Godspeed's own installer put in its folder, or the one Hermes brings.
host_node() {
  local c d h
  local homes=("$HOME")
  for h in /home/*; do [ -d "$h" ] && homes+=("$h"); done
  for c in "${FORGE_NODE:-}" "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node /var/lib/godspeed/forge/runtime/node; do
    if usable_node "$c"; then printf '%s\n' "$c"; return 0; fi
  done
  for h in "${homes[@]}"; do
    for d in "${GODSPEED_DIR:-}" "$(device_dir "$h")" "$h/godspeed" "$h/godspeed-v2"; do
      [ -n "$d" ] || continue
      for c in "$d"/.godspeed/integrated-runtime/runtime/node-v*/bin/node; do
        if usable_node "$c"; then printf '%s\n' "$c"; return 0; fi
      done
    done
    for c in "$h"/.hermes/tools/node-*/bin/node; do
      if usable_node "$c"; then printf '%s\n' "$c"; return 0; fi
    done
  done
  return 1
}

# On Godspeed's Docker server: a copy of the Node inside Godspeed's container, in this run's temporary folder.
container_node() {
  local d id bundled
  command -v docker >/dev/null 2>&1 || return 1
  for d in "${GODSPEED_DOCKER_DIR:-}" /opt/* $(docker ps --filter label=com.docker.compose.service=godspeed --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null || true); do
    [ -n "$d" ] && [ -f "$d/compose.yaml" ] && [ -f "$d/.godspeed/model-host.json" ] || continue
    id="$(docker compose -f "$d/compose.yaml" --project-directory "$d" ps -q godspeed 2>/dev/null | head -n 1 || true)"
    [ -n "$id" ] || continue
    bundled="$(docker compose -f "$d/compose.yaml" --project-directory "$d" exec -T --user hermes godspeed node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
    case "$bundled" in /*) ;; *) continue ;; esac
    mkdir -p "$temporary/bin"
    if docker cp "$id:$bundled" "$temporary/bin/node" >/dev/null 2>&1 && chmod 755 "$temporary/bin/node" && usable_node "$temporary/bin/node"; then
      printf '%s\n' "$temporary/bin/node"
      return 0
    fi
  done
  return 1
}

# Downloads the Forge release to install into the temporary folder and prints its folder.
download() {
  local tag archive_url
  tag="${FORGE_VERSION:-}"
  if [ -n "$tag" ]; then
    archive_url="https://github.com/MichaelZelbel/godspeed-forge/archive/refs/tags/${tag}.tar.gz"
  elif [ -n "${FORGE_ARCHIVE_URL:-}" ]; then
    archive_url="$FORGE_ARCHIVE_URL"
  else
    tag="$(curl -fsSL https://api.github.com/repos/MichaelZelbel/godspeed-forge/releases/latest 2>/dev/null | "$node" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=JSON.parse(d).tag_name;if(typeof t==="string"&&/^[A-Za-z0-9._-]+$/.test(t))console.log(t)}catch{}})' 2>/dev/null || true)"
    if [ -z "$tag" ]; then
      stop "The Forge could not find its newest release on GitHub, so nothing was installed: GitHub did not answer or has no release yet. Try again in a minute, or name a release with FORGE_VERSION=<tag>."
    fi
    archive_url="https://github.com/MichaelZelbel/godspeed-forge/archive/refs/tags/${tag}.tar.gz"
  fi
  if ! curl -fsSL "$archive_url" -o "$temporary/forge.tar.gz"; then
    stop "The Forge could not be downloaded from GitHub, so nothing was installed. Check that this server can reach github.com, then run this line again."
  fi
  mkdir -p "$temporary/source"
  tar -xzf "$temporary/forge.tar.gz" -C "$temporary/source" || stop "$UNPACK_FAILED"
  find "$temporary/source" -mindepth 1 -maxdepth 1 -type d | head -n 1
}

install_from() {
  local source_directory="$1" settings_dir addon driver_node
  FORGE_SOURCE="$source_directory" FORGE_MINIMUM_GODSPEED="$MINIMUM_GODSPEED" FORGE_TEMPORARY_NODE="$temporary_node" \
    "$node" "$source_directory/lib/install/run.mjs"

  # An upgrade keeps the factory driver current: as root where this server has the driver's settings, the install ends
  # with `godspeed-forge driver install`.
  settings_dir="${FORGE_SETTINGS_DIR:-/etc/godspeed-forge}"
  if [ "$(id -u)" = "0" ] && [ "$(uname -s)" = "Linux" ] && [ -f "$settings_dir/driver.json" ]; then
    if [ -n "${FORGE_INSTALL_ROOT:-}" ]; then
      addon="$FORGE_INSTALL_ROOT/addon"
    else
      addon="$(SOURCE_DIRECTORY="$source_directory" "$node" --input-type=module -e 'const { defaultPaths } = await import(`file://${process.env.SOURCE_DIRECTORY}/lib/config.mjs`); console.log(defaultPaths().addon);')"
    fi
    driver_node="$(host_node || true)"
    [ -n "$driver_node" ] || driver_node="$node"
    "$driver_node" "$addon/bin/godspeed-forge.mjs" driver install --settings-dir "$settings_dir"
  fi
  say "The Forge is installed."
  say "$NEXT_STEP"
}

main() {
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  trap 'exit 1' HUP INT TERM

  node="$(host_node || true)"
  temporary_node="${FORGE_TEMPORARY_NODE:-}"
  if [ -z "$node" ]; then
    node="$(container_node || true)"
    temporary_node="$node"
  fi
  [ -n "$node" ] || stop "$NONE_FOUND"

  if [ -n "${FORGE_SOURCE:-}" ]; then
    install_from "$FORGE_SOURCE"
    return 0
  fi
  source_directory="$(download)"
  [ -n "$source_directory" ] && [ -d "$source_directory/lib" ] || stop "$UNPACK_FAILED"
  if [ -f "$source_directory/install.sh" ]; then
    # The release installs itself with its own copy of this file, with the Node found here.
    FORGE_SOURCE="$source_directory" FORGE_NODE="$node" FORGE_TEMPORARY_NODE="$temporary_node" PATH="$(dirname "$node"):$PATH" \
      bash "$source_directory/install.sh"
    return 0
  fi
  install_from "$source_directory"
}

main "$@"
