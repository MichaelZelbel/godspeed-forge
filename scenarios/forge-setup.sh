#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

owner_requests_setup() {
  scenario_fail "Forge setup command is missing"
}

assert_setup_result() {
  assert_contains /scenario/notices.txt "Codex"
  assert_contains /scenario/notices.txt "cost"
  assert_count /scenario/questions.txt "What is the software for?" 1
  assert_count /scenario/questions.txt "Who uses it?" 1
  [ "$(wc -l </scenario/questions.txt)" -eq 2 ] || \
    scenario_fail "Setup asked questions beyond the required two"
  assert_file /scenario/sample/MISSION.md
  assert_contains /scenario/sample/MISSION.md "Keeps a sample result"
  assert_contains /scenario/sample/MISSION.md "Sample maintainers"
  assert_file /scenario/config.json
  assert_no_secrets /scenario/sample /scenario/config.json
  diff -qr /scenario/expected-factory /scenario/sample/factory >/dev/null || \
    scenario_fail "Installed factory differs from its pinned source"
  python3 /scenario/sample/factory/consumer.py doctor
}

if [ "${1-}" = "--inside" ]; then
  codex login status >/scenario/artifacts/agent-status
  owner_requests_setup
  assert_setup_result
else
  scenario_start forge-setup "$0"
fi
