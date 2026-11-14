#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

owner_plans_release() {
  scenario_fail "Forge plan-release command is missing"
}

assert_release_planned() {
  gh issue list --json number,title > /scenario/artifacts/issues.json
  assert_count /scenario/artifacts/issues.json '"number"' 1
}

assert_release_staged_once() {
  assert_count /scenario/notices.txt "on staging" 1
  assert_contains /scenario/public-version.txt "previous"
}

assert_release_published_and_taken_back() {
  assert_contains /scenario/artifacts/after-go.txt "release"
  assert_contains /scenario/public-version.txt "previous"
  gh release view v2 --json isPrerelease,isLatest > /scenario/artifacts/release.json
  assert_contains /scenario/artifacts/release.json '"isPrerelease": true'
}

if [ "${1-}" = "--inside" ]; then
  codex login status >/scenario/artifacts/agent-status
  owner_plans_release
  assert_release_planned
  assert_release_staged_once
  assert_release_published_and_taken_back
else
  scenario_start forge-one-release "$0"
fi
