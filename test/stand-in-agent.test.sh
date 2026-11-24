#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 3

root=$(mktemp -d)
trap 'test_cases_end; rm -rf "$root"' EXIT
agent="$PWD/test/stand-in-agent/codex"

test_case "the stand-in agent says it is a stand-in when asked for its sign-in"
env -i PATH="$PATH" "$agent" login status >"$root/login"
grep -F "scenario stand-in" "$root/login" >/dev/null

test_case "the stand-in agent applies its fixture change and answers deterministically"
mkdir -p "$root/repo" "$root/fixture"
git -C "$root/repo" init -q
printf 'before\n' >"$root/repo/result.txt"
git -C "$root/repo" add result.txt
git -C "$root/repo" -c user.name=Scenario -c user.email=scenario@example.invalid commit -qm initial
printf 'after\n' >"$root/repo/result.txt"
git -C "$root/repo" diff >"$root/fixture/change.patch"
git -C "$root/repo" checkout -q -- result.txt
printf 'deterministic response\n' >"$root/fixture/response"
printf 'build this fixture\n' >"$root/request"
(
  cd "$root/repo"
  env -i PATH="$PATH" STANDIN_AGENT_FIXTURE="$root/fixture" \
    STANDIN_AGENT_TRANSCRIPT="$root/transcript" "$agent" exec "$root/request"
) >"$root/response"
grep -Fx "after" "$root/repo/result.txt" >/dev/null
grep -Fx "deterministic response" "$root/response" >/dev/null
grep -Fx "exec" "$root/transcript/argv" >/dev/null
cmp "$root/request" "$root/transcript/request"

test_case "a failure fixture exits 23 and an unsupported command is refused"
set +e
env -i PATH="$PATH" STANDIN_AGENT_FIXTURE="$PWD/test/stand-in-agent/fixtures/failure" \
  STANDIN_AGENT_TRANSCRIPT="$root/failure-transcript" "$agent" exec "$root/request" >/dev/null
failure_status=$?
env -i PATH="$PATH" "$agent" something-else >/dev/null 2>"$root/unsupported"
unsupported_status=$?
set -e
[ "$failure_status" -eq 23 ]
[ "$unsupported_status" -ne 0 ]
grep -F "unsupported command" "$root/unsupported" >/dev/null

echo "stand-in agent: pass"
