#!/usr/bin/env bash
set -eu

MINIMUM_GODSPEED="2.0.0-beta.24"

main() {
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT HUP INT TERM

  installed="${GODSPEED_VERSION:-}"
  if [ -z "$installed" ]; then
    installed="$(godspeed --version 2>/dev/null | sed 's/^godspeed //' || true)"
  fi
  if [ -z "$installed" ] && [ -x "${HOME}/.local/bin/godspeed" ]; then
    installed="$("${HOME}/.local/bin/godspeed" --version 2>/dev/null | sed 's/^godspeed //' || true)"
  fi
  if ! node -e 'const p=v=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v);if(!m)process.exit(2);return m.slice(1).map(x=>x===undefined?Number.MAX_SAFE_INTEGER:Number(x))};const a=p(process.argv[1]),b=p(process.argv[2]);for(let i=0;i<a.length;i++){if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1)}' "$installed" "$MINIMUM_GODSPEED"; then
    echo "Godspeed $installed is installed; the Forge requires Godspeed $MINIMUM_GODSPEED or newer." >&2
    exit 1
  fi

  source_directory="${FORGE_SOURCE:-}"
  if [ -z "$source_directory" ]; then
    archive_url="${FORGE_ARCHIVE_URL:-}"
    if [ -z "$archive_url" ]; then
      tag="${FORGE_VERSION:-}"
      if [ -z "$tag" ]; then
        tag="$(curl -fsSL https://api.github.com/repos/MichaelZelbel/godspeed-forge/releases/latest 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=JSON.parse(d).tag_name;if(typeof t==="string"&&/^[A-Za-z0-9._-]+$/.test(t))console.log(t)}catch{}})' 2>/dev/null || true)"
      fi
      if [ -z "$tag" ]; then
        echo "The Forge could not find its newest release on GitHub, so nothing was installed: GitHub did not answer or has no release yet. Try again in a minute, or name a release with FORGE_VERSION=<tag>." >&2
        exit 1
      fi
      archive_url="https://github.com/MichaelZelbel/godspeed-forge/archive/refs/tags/${tag}.tar.gz"
    fi
    archive="$temporary/forge.tar.gz"
    curl -fsSL "$archive_url" -o "$archive"
    tar -xzf "$archive" -C "$temporary"
    source_directory="$(find "$temporary" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  fi
  workspace="${GODSPEED_WORKSPACE:-${HOME}/.godspeed/workspace}"
  SOURCE_DIRECTORY="$source_directory" WORKSPACE="$workspace" node --input-type=module <<'NODE'
const { installAddon } = await import(`file://${process.env.SOURCE_DIRECTORY}/lib/install/install.mjs`);
const paths = process.env.FORGE_INSTALL_ROOT
  ? { addon: `${process.env.FORGE_INSTALL_ROOT}/addon`, executable: `${process.env.FORGE_INSTALL_ROOT}/bin/godspeed-forge`, config: `${process.env.FORGE_INSTALL_ROOT}/config.json`, state: `${process.env.FORGE_INSTALL_ROOT}/state` }
  : undefined;
await installAddon({ source: process.env.SOURCE_DIRECTORY, workspace: process.env.WORKSPACE, paths });
NODE
  echo "The Forge is installed."

  # An upgrade keeps the factory driver current: as root where this server has the driver's settings, the install ends with
  # `godspeed-forge driver install`.
  settings_dir="${FORGE_SETTINGS_DIR:-/etc/godspeed-forge}"
  if [ "$(id -u)" = "0" ] && [ "$(uname -s)" = "Linux" ] && [ -f "$settings_dir/driver.json" ]; then
    if [ -n "${FORGE_INSTALL_ROOT:-}" ]; then
      addon="$FORGE_INSTALL_ROOT/addon"
    else
      addon="$(SOURCE_DIRECTORY="$source_directory" node --input-type=module -e 'const { defaultPaths } = await import(`file://${process.env.SOURCE_DIRECTORY}/lib/config.mjs`); console.log(defaultPaths().addon);')"
    fi
    node "$addon/bin/godspeed-forge.mjs" driver install --settings-dir "$settings_dir"
  fi
}

main "$@"
