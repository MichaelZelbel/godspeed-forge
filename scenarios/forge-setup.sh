#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

owner_requests_setup() {
  scenario_fail "Forge setup command is missing"
}

assert_setup_result() {
  assert_file /scenario/sample/MISSION.md
  assert_contains /scenario/sample/MISSION.md "what the software is for"
  assert_contains /scenario/sample/MISSION.md "who uses it"
  assert_file /scenario/config.json
  assert_no_secrets /scenario/sample /scenario/config.json
  python3 /scenario/sample/factory/consumer.py doctor
}

if [ "${1-}" = "--inside" ]; then
  codex login status >/scenario/artifacts/agent-status
  owner_requests_setup
  assert_setup_result
else
  scenario_start forge-setup "$0"
fi
