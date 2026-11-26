#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

owner_plans_release() {
  scenario_forge_start
  gh release create v1.0.0 --title "1.0.0" --notes "Previous" >/dev/null
  scenario_public_version /scenario/public-before.txt
  printf 'v2.0.0\n' >/scenario/release-version.txt
  scenario_owner_says plan "Yes, plan it." '{"plan":{"version":"2.0.0","summary":"People can see their sample result at once.","items":[{"title":"Show the sample result at once","outcome":"When you open the sample, its result is on the first screen.","why":"People look for the result first.","size":"light"}]}}' \
    >/scenario/artifacts/plan.json
  assert_contains /scenario/artifacts/plan.json '"ok":true'
}

# What the factory does for the item: a pull request that closes its issue, merged into the main branch.
factory_delivers_item() {
  git -C /scenario/sample checkout -q -b item-1
  printf 'The result is on the first screen.\n' >/scenario/sample/result.txt
  git -C /scenario/sample add result.txt
  git -C /scenario/sample -c user.name=Scenario -c user.email=scenario@example.invalid commit -qm "Show the sample result at once"
  git -C /scenario/sample push -q origin item-1
  gh pr create --title "Show the sample result at once" --body "Closes #1" --head item-1 --base main >/dev/null
  gh pr merge 1
  git -C /scenario/sample checkout -q main
}

forge_checks_and_stages() {
  node /forge/bin/godspeed-forge.mjs driver step owner-releases --settings-dir "$HOME/settings" \
    >/scenario/artifacts/owner-releases-step.json
  assert_contains /scenario/artifacts/owner-releases-step.json '"ok":true'
  scenario_notices
  scenario_public_version /scenario/public-after-staging.txt
}

owner_says_go_then_takes_back() {
  scenario_owner_says go "go" >/scenario/artifacts/go.json
  assert_contains /scenario/artifacts/go.json '"ok":true'
  scenario_public_version /scenario/public-after-go.txt
  scenario_owner_says take-back "Take it back." >/scenario/artifacts/take-back.json
  assert_contains /scenario/artifacts/take-back.json '"ok":true'
  scenario_public_version /scenario/public-after-take-back.txt
}

assert_release_planned() {
  gh issue list --json number,title > /scenario/artifacts/issues.json
  assert_count /scenario/artifacts/issues.json '"number"' 1
}

assert_release_staged_once() {
  assert_count /scenario/notices.txt "is ready to try" 1
  cmp /scenario/public-before.txt /scenario/public-after-staging.txt || \
    scenario_fail "The public version changed before the owner's go"
}

assert_release_published_and_taken_back() {
  cmp /scenario/release-version.txt /scenario/public-after-go.txt || \
    scenario_fail "The owner's go did not publish the release"
  cmp /scenario/public-before.txt /scenario/public-after-take-back.txt || \
    scenario_fail "Take-back did not restore the previous public version"
  gh release view v2.0.0 --json isPrerelease,isLatest > /scenario/artifacts/release.json
  assert_contains /scenario/artifacts/release.json '"isPrerelease": true'
}

if [ "${1-}" = "--inside" ]; then
  codex login status >/scenario/artifacts/agent-status
  owner_plans_release
  assert_release_planned
  factory_delivers_item
  forge_checks_and_stages
  assert_release_staged_once
  owner_says_go_then_takes_back
  assert_release_published_and_taken_back
else
  scenario_start forge-one-release "$0"
fi
