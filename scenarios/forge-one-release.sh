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
  cmp /scenario/public-before.txt /scenario/public-after-staging.txt || \
    scenario_fail "The public version changed before the owner's go"
}

assert_release_published_and_taken_back() {
  cmp /scenario/release-version.txt /scenario/public-after-go.txt || \
    scenario_fail "The owner's go did not publish the release"
  cmp /scenario/public-before.txt /scenario/public-after-take-back.txt || \
    scenario_fail "Take-back did not restore the previous public version"
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
