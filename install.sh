#!/usr/bin/env bash
set -eu

MINIMUM_GODSPEED="2.0.0-beta.24"

main() {
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT HUP INT TERM

  installed="${GODSPEED_VERSION:-}"
  if [ -z "$installed" ]; then
    installed="$(godspeed --version 2>/dev/null | sed 's/^godspeed //')"
  fi
  if ! node -e 'const p=v=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v);if(!m)process.exit(2);return m.slice(1).map(x=>x===undefined?Number.MAX_SAFE_INTEGER:Number(x))};const a=p(process.argv[1]),b=p(process.argv[2]);for(let i=0;i<a.length;i++){if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1)}' "$installed" "$MINIMUM_GODSPEED"; then
    echo "Godspeed $installed is installed; the Forge requires Godspeed $MINIMUM_GODSPEED or newer." >&2
    exit 1
  fi

  source_directory="${FORGE_SOURCE:-}"
  if [ -z "$source_directory" ]; then
    archive="$temporary/forge.tar.gz"
    curl -fsSL "${FORGE_ARCHIVE_URL:-https://github.com/MichaelZelbel/godspeed-forge/archive/refs/heads/main.tar.gz}" -o "$archive"
    tar -xzf "$archive" -C "$temporary"
    source_directory="$(find "$temporary" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  fi
  workspace="${GODSPEED_WORKSPACE:-${HOME}/.godspeed/workspace}"
  SOURCE_DIRECTORY="$source_directory" WORKSPACE="$workspace" node --input-type=module <<'NODE'
const { installAddon } = await import(`file://${process.env.SOURCE_DIRECTORY}/lib/install/install.mjs`);
const paths = process.env.FORGE_INSTALL_ROOT
  ? { addon: `${process.env.FORGE_INSTALL_ROOT}/addon`, executable: `${process.env.FORGE_INSTALL_ROOT}/bin/godspeed-forge`, config: `${process.env.FORGE_INSTALL_ROOT}/config.json`, state: `${process.env.FORGE_INSTALL_ROOT}/state`, units: `${process.env.FORGE_INSTALL_ROOT}/systemd` }
  : undefined;
await installAddon({ source: process.env.SOURCE_DIRECTORY, workspace: process.env.WORKSPACE, paths, scheduler: paths ? null : undefined });
NODE
  echo "The Forge is installed."
}

main "$@"
