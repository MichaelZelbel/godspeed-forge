#!/usr/bin/env bash
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM

node bin/prove-plan-release.mjs "$root/no" no >"$root/no-output"
grep -F 'Shall I start it?' "$root/no-output" >/dev/null
grep -F '"approved":false' "$root/no-output" >/dev/null
[ "$(cat "$root/no/issues.json")" = '[]' ]
[ ! -d "$root/no/state/projects/sample/project/releases" ]

node bin/prove-plan-release.mjs "$root/yes" yes >"$root/yes-output"
grep -F '1. Saving keeps the person’s progress.' "$root/yes-output" >/dev/null
grep -F '2. Opening reliably returns people to their work.' "$root/yes-output" >/dev/null
grep -F 'Deferred: A clearer project overview' "$root/yes-output" >/dev/null
grep -F 'Cost:' "$root/yes-output" >/dev/null
grep -F 'Version: 1.1.0' "$root/yes-output" >/dev/null
grep -Fx 'Shall I start it?' "$root/yes-output" >/dev/null
grep -F '"approved":true' "$root/yes-output" >/dev/null
grep -F '"issueCount":2' "$root/yes-output" >/dev/null
[ "$(grep -c '"number"' "$root/yes/issues.json")" -eq 2 ]
for heading in 'Problem' 'Why' 'Why now' 'Outcome' 'Invariants' 'Acceptance' 'Done means' 'Size' 'Dependencies' 'Reason'; do
  grep -F "## $heading" "$root/yes/issues.json" >/dev/null
done
grep -F '"status": "approved"' "$root/yes/state/projects/sample/project/releases/1-1-0/plan.json" >/dev/null
grep -F '"issue-1"' "$root/yes/state/projects/sample/project/releases/1-1-0/plan.json" >/dev/null
grep -F '"issue-2"' "$root/yes/state/projects/sample/project/releases/1-1-0/plan.json" >/dev/null
