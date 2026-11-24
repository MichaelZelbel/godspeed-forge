#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

# What the coding agent does when setup asks it to read the project: the seven proposals, the journeys, the checks.
write_agent_fixture() {
  cat >/scenario/agent-fixture/run <<'AGENT'
python3 - <<'PY'
import json
json.dump(["A hosted service that other people sign up for.", "A paid plan with accounts and billing.",
           "A mobile app for the sample.", "A plug-in system for other developers.",
           "A dashboard that tracks every visitor.", "A chat feature between users.",
           "A rewrite in another language."], open(".forge-out-of-scope.json", "w"))
open("harness/END-TO-END.md", "w").write("# End-to-end journeys\n\n## Read the sample\n\n1. Open the sample.\n\n"
    "**What would make this fail:** the user sees nothing.\n\n## Keep a sample result\n\n1. Save a result.\n\n"
    "**What would make this fail:** the result is not kept.\n")
config = json.load(open("harness/harness.config.json"))
config.update({"static": "", "unit": "", "required_checks": "none"})
json.dump(config, open("harness/harness.config.json", "w"), indent=2)
PY
AGENT
}

# The folder the pinned factory ships, for the comparison with what setup installed.
write_expected_factory() {
  mkdir -p /scenario/expected-factory
  git --git-dir=/opt/mirrors/factory.git archive pinned template/factory | tar -x -C /scenario/expected-factory --strip-components=2
  mkdir -p /scenario/expected-template
  git --git-dir=/opt/mirrors/factory.git archive pinned template | tar -x -C /scenario/expected-template --strip-components=1
}

# The owner's side: setup in the sample, answered the way the owner would. The two Apps' pages are done by the
# stand-in GitHub, which hands back the App for the temporary code in the address the owner pastes.
owner_requests_setup() {
  gh serve >/scenario/artifacts/github-serve.log 2>&1 &
  for _ in $(seq 100); do
    [ -f /scenario/github/rest.port ] && break
    sleep 0.1
  done
  [ -f /scenario/github/rest.port ] || scenario_fail "The stand-in GitHub did not start"
  FORGE_GITHUB_API_URL="http://127.0.0.1:$(cat /scenario/github/rest.port)"
  export FORGE_GITHUB_API_URL
  write_agent_fixture
  write_expected_factory
  mkdir -p "$HOME/.godspeed/forge"
  printf '{"projectsRoot":"/"}\n' >"$HOME/.godspeed/forge/config.json"
  # setup downloads the project the way an owner's server does: there is no checkout yet.
  cd /scenario
  rm -rf /scenario/sample
  printf '%s\n' no "http://127.0.0.1/?code=builder-1" yes no "http://127.0.0.1/?code=release-1" yes \
    "Keeps a sample result" "Sample maintainers" "" yes |
    node /forge/bin/godspeed-forge.mjs setup scenario/sample >/scenario/notices.txt 2>/scenario/artifacts/setup.stderr || \
    scenario_fail "Setup stopped: $(grep -v '^[[:space:]]*$' /scenario/notices.txt | tail -n 1)"
  grep -E '^(What is this software for\?|Who uses it\?)' /scenario/notices.txt >/scenario/questions.txt || true
  cp "$HOME/.godspeed/forge/config.json" /scenario/config.json
  cd /scenario/sample
}

assert_setup_result() {
  assert_contains /scenario/notices.txt "Codex"
  assert_contains /scenario/notices.txt "cost"
  assert_count /scenario/questions.txt "What is this software for?" 1
  assert_count /scenario/questions.txt "Who uses it?" 1
  [ "$(wc -l </scenario/questions.txt)" -eq 2 ] || \
    scenario_fail "Setup asked questions beyond the required two"
  assert_file /scenario/sample/MISSION.md
  assert_contains /scenario/sample/MISSION.md "Keeps a sample result"
  assert_contains /scenario/sample/MISSION.md "Sample maintainers"
  assert_file /scenario/config.json
  # The factory's own source (checked identical to its pinned download below) has code that handles tokens; what the
  # pattern must find nothing in is every other file in the project, and the Forge's settings.
  scan_files=$(find /scenario/sample -path /scenario/sample/.git -prune -o -path /scenario/sample/.factory -prune -o -type f -print |
    while read -r file; do
      cmp -s "$file" "/scenario/expected-template${file#/scenario/sample}" || printf '%s\n' "$file"
    done)
  # shellcheck disable=SC2086
  assert_no_secrets $scan_files /scenario/config.json
  # And the Apps' keys, which setup holds in its private state, are in no file of the project at all.
  if grep -rl --exclude-dir=.factory "BEGIN RSA PRIVATE KEY\|BEGIN PRIVATE KEY" /scenario/sample >/dev/null; then
    scenario_fail "A key or token was written to scenario state"
  fi
  diff -qr /scenario/expected-factory /scenario/sample/factory >/dev/null || \
    scenario_fail "Installed factory differs from its pinned source"
  python3 /scenario/sample/factory/consumer.py doctor >/scenario/artifacts/doctor.json
}

if [ "${1-}" = "--inside" ]; then
  # What the container made is the container user's; the host that removes it afterwards must be able to.
  trap 'chmod -R a+rwX /scenario 2>/dev/null || true' EXIT
  codex login status >/scenario/artifacts/agent-status
  owner_requests_setup
  assert_setup_result
else
  scenario_start forge-setup "$0"
fi
