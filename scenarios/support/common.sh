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

scenario_cleanup() {
  if [ -n "${SCENARIO_ROOT-}" ] && [ -d "$SCENARIO_ROOT" ]; then
    rm -rf "$SCENARIO_ROOT"
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
  STANDIN_GITHUB_STATE="$SCENARIO_ROOT/github" \
    "$repository_root/test/stand-in-github/control" init \
      --remote "$SCENARIO_ROOT/remote.git" --runtime-remote /scenario/remote.git

  if ! docker build -q \
    --build-arg GODSPEED_REVISION=candidate/2.0.0-beta.24 \
    -f "$repository_root/scenarios/support/Dockerfile" "$repository_root" \
    >"$SCENARIO_ROOT/artifacts/image.stdout" 2>"$SCENARIO_ROOT/artifacts/image.stderr"; then
    scenario_fail "Scenario container could not be prepared"
  fi
  image=$(tail -n 1 "$SCENARIO_ROOT/artifacts/image.stdout")
  printf '%s\n' "$image" >"$SCENARIO_ROOT/artifacts/image-id"
  if ! docker run --rm \
    -e HOME=/home/scenario \
    -e PATH=/forge/test/stand-in-agent:/forge/test/stand-in-github:/usr/local/bin:/usr/bin:/bin \
    -e STANDIN_AGENT_FIXTURE=/scenario/agent-fixture \
    -e STANDIN_AGENT_TRANSCRIPT=/scenario/transcript \
    -e STANDIN_GITHUB_STATE=/scenario/github \
    -e GH_TOKEN= -e GITHUB_TOKEN= -e OPENAI_API_KEY= -e ANTHROPIC_API_KEY= \
    -e HTTP_PROXY= -e HTTPS_PROXY= -e ALL_PROXY= \
    -v "$repository_root:/forge:ro" \
    -v "$SCENARIO_ROOT:/scenario" \
    -w /scenario/sample \
    "$image" bash "/forge/scenarios/$scenario_name.sh" --inside; then
    return 1
  fi
}
