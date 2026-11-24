#!/usr/bin/env bash
set -eu

scenario_fail() {
  printf '%s\n' "$1"
  exit 1
}

assert_file() {
  [ -f "$1" ] || scenario_fail "Expected file is missing: $1"
}

assert_contains() {
  grep -F "$2" "$1" >/dev/null || scenario_fail "Expected text is missing from $1"
}

assert_count() {
  actual=$(grep -F -c "$2" "$1" || true)
  [ "$actual" -eq "$3" ] || scenario_fail "Expected $3 occurrences in $1, found $actual"
}

assert_no_secrets() {
  if grep -Eri '(api[_-]?key|token|secret)["'\''[:space:]]*[:=][[:space:]]*["'\'']?[^"'\''[:space:]}]+' "$@" >/dev/null; then
    scenario_fail "A key or token was written to scenario state"
  fi
}

# Inside the container: the stand-in GitHub's REST face, and the project the Forge has set up for the owner. The
# address is exported for the Forge, which reads it as FORGE_GITHUB_API_URL; port 0 keeps two runs apart.
scenario_forge_start() {
  gh serve >/scenario/artifacts/github-serve.log 2>&1 &
  for _ in $(seq 100); do
    [ -f /scenario/github/rest.port ] && break
    sleep 0.1
  done
  [ -f /scenario/github/rest.port ] || scenario_fail "The stand-in GitHub did not start"
  FORGE_GITHUB_API_URL="http://127.0.0.1:$(cat /scenario/github/rest.port)"
  export FORGE_GITHUB_API_URL
  git -C /scenario/sample remote set-url origin /scenario/remote.git
  node /forge/scenarios/support/owner.mjs seed
}

scenario_owner_says() {
  node /forge/scenarios/support/owner.mjs say "$@"
}

# The tag of the release GitHub shows as the latest, written to the file named.
scenario_public_version() {
  gh release list --json tagName,isLatest | python3 -c \
    'import json, sys; print(next(r["tagName"] for r in json.load(sys.stdin) if r["isLatest"]))' >"$1"
}

scenario_notices() {
  node /forge/scenarios/support/owner.mjs notices >/scenario/notices.txt
}

scenario_cleanup() {
  if [ -z "${SCENARIO_KEEP-}" ] && [ -n "${SCENARIO_ROOT-}" ] && [ -d "$SCENARIO_ROOT" ]; then
    rm -rf "$SCENARIO_ROOT"
  fi
  if [ -n "${image_tag-}" ]; then
    docker rmi "$image_tag" >/dev/null 2>&1 || true
  fi
}

scenario_start() {
  scenario_name=$1
  scenario_script=$2
  repository_root=$(cd "$(dirname "$scenario_script")/.." && pwd)
  SCENARIO_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/${scenario_name}.XXXXXX")
  export SCENARIO_ROOT
  trap scenario_cleanup EXIT HUP INT TERM
  chmod 777 "$SCENARIO_ROOT"
  mkdir -p "$SCENARIO_ROOT/artifacts" "$SCENARIO_ROOT/github" "$SCENARIO_ROOT/transcript" \
    "$SCENARIO_ROOT/sample" "$SCENARIO_ROOT/agent-fixture"
  chmod 777 "$SCENARIO_ROOT/artifacts" "$SCENARIO_ROOT/github" "$SCENARIO_ROOT/transcript" \
    "$SCENARIO_ROOT/sample" "$SCENARIO_ROOT/agent-fixture"
  git init -q --bare "$SCENARIO_ROOT/remote.git"
  git -C "$SCENARIO_ROOT/sample" init -q
  git -C "$SCENARIO_ROOT/sample" config user.name Scenario
  git -C "$SCENARIO_ROOT/sample" config user.email scenario@example.invalid
  printf 'sample\n' >"$SCENARIO_ROOT/sample/README.md"
  git -C "$SCENARIO_ROOT/sample" add README.md
  git -C "$SCENARIO_ROOT/sample" commit -qm initial
  git -C "$SCENARIO_ROOT/sample" branch -M main
  git -C "$SCENARIO_ROOT/sample" remote add origin "$SCENARIO_ROOT/remote.git"
  git -C "$SCENARIO_ROOT/sample" push -q origin main
  git --git-dir="$SCENARIO_ROOT/remote.git" symbolic-ref HEAD refs/heads/main
  chmod -R a+rwX "$SCENARIO_ROOT/remote.git" "$SCENARIO_ROOT/sample"
  STANDIN_GITHUB_STATE="$SCENARIO_ROOT/github" \
    "$repository_root/test/stand-in-github/control" init \
      --remote "$SCENARIO_ROOT/remote.git" --runtime-remote /scenario/remote.git

  # Tagged, so a cleanup of untagged images between the build and the run cannot take it; the tag is dropped at the end.
  image_tag="forge-scenario:$(basename "$SCENARIO_ROOT" | tr 'A-Z' 'a-z')"
  if ! docker build -q -t "$image_tag" \
    --build-arg GODSPEED_REVISION=candidate/2.0.0-beta.24 \
    -f "$repository_root/scenarios/support/Dockerfile" "$repository_root" \
    >"$SCENARIO_ROOT/artifacts/image.stdout" 2>"$SCENARIO_ROOT/artifacts/image.stderr"; then
    scenario_fail "Scenario container could not be prepared"
  fi
  image=$image_tag
  docker image inspect --format '{{.Id}}' "$image_tag" >"$SCENARIO_ROOT/artifacts/image-id"
  if ! docker run --rm \
    -e HOME=/home/scenario \
    -e PATH=/forge/test/stand-in-agent:/forge/test/stand-in-github:/usr/local/bin:/usr/bin:/bin \
    -e STANDIN_AGENT_FIXTURE=/scenario/agent-fixture \
    -e STANDIN_AGENT_TRANSCRIPT=/scenario/transcript \
    -e STANDIN_GITHUB_STATE=/scenario/github \
    -e GODSPEED_WORKSPACE=/home/scenario/godspeed -e GODSPEED_VERSION=2.0.0-beta.24 \
    -e GH_TOKEN= -e GITHUB_TOKEN= -e OPENAI_API_KEY= -e ANTHROPIC_API_KEY= \
    -e HTTP_PROXY= -e HTTPS_PROXY= -e ALL_PROXY= \
    -v "$repository_root:/forge:ro" \
    -v "$SCENARIO_ROOT:/scenario" \
    -w /scenario/sample \
    "$image" bash -c 'umask 000; git config --global safe.directory "*"; exec bash "$@"' bash "/forge/scenarios/$scenario_name.sh" --inside; then
    return 1
  fi
}
