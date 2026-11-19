#!/usr/bin/env bash
# The Forge's whole test, as the `required` check and the factory's harness run it.
# Every file test/*.test.sh runs with bash and every test/*.test.mjs with node. Each file marks its cases
# (test/cases.sh, test/cases.mjs) and prints "case passed: <name>" or "case failed: <name>" for each.
# Each file also says how many cases it has, in a line "# test cases: <n>" (bash) or
# "// test cases: <n>" (node). A file stops at its first failing case, so the cases after it are counted
# as not run, and the total stays the same as on a passing run.
# Prints "<n> of <m> pass" counting cases across all files (the factory's harness reads that line), where
# <n> counts only cases that passed, and exits 1, naming the file and the case, when any case fails, a
# file fails outside a case, a file reports no cases, a file runs a different number of cases than it
# says it has, or a file reaches for the network.
# No test reaches the network: every file runs with test/offline first on PATH (a git that reaches only
# repositories on this machine) and test/offline/no-network.mjs loaded into node, and each attempt they
# refuse fails the file that made it, naming what it tried to reach.
set -u
cd "$(dirname "$0")/.."
offline="$(pwd)/test/offline"
pass=0
total=0
not_run=0
failed=()
skipped=()
output="$(mktemp)"
network="$(mktemp)"
trap 'rm -f "$output" "$network"' EXIT
export FORGE_TEST_NETWORK_LOG="$network"
export PATH="$offline:$PATH"
export GIT_ALLOW_PROTOCOL=file
export NODE_OPTIONS="--import \"$offline/no-network.mjs\"${NODE_OPTIONS:+ $NODE_OPTIONS}"
shopt -s nullglob
for t in test/*.test.sh test/*.test.mjs; do
  echo "== $t"
  case "$t" in
    *.sh) bash "$t" | tee "$output" ;;
    *.mjs) node "$t" | tee "$output" ;;
  esac
  status=${PIPESTATUS[0]}
  passed="$(grep -c '^case passed: ' "$output")"
  failing="$(grep -c '^case failed: ' "$output")"
  reached=$((passed + failing))
  declared="$(sed -nE 's;^(#|//) test cases: ([0-9]+)$;\2;p' "$t" | head -n 1)"
  file_total=$reached
  file_failures=${#failed[@]}
  while IFS= read -r name; do failed+=("$t: $name"); done < <(sed -n 's/^case failed: //p' "$output")
  while IFS= read -r attempt; do failed+=("$t: reached for the network: $attempt"); done <"$network"
  : >"$network"
  if [ "$status" -ne 0 ] && [ "$failing" -eq 0 ]; then
    failed+=("$t: outside any case (exit $status)")
  elif [ "$status" -eq 0 ] && [ "$passed" -eq 0 ]; then
    failed+=("$t: reported no cases")
  fi
  if [ -z "$declared" ]; then
    failed+=("$t: does not say how many cases it has (add a \"test cases: <n>\" comment line)")
  elif [ "$reached" -gt "$declared" ] || { [ "$status" -eq 0 ] && [ "$reached" -gt 0 ] && [ "$reached" -ne "$declared" ]; }; then
    failed+=("$t: says it has $declared cases but ran $reached")
  elif [ "$reached" -lt "$declared" ]; then
    missing=$((declared - reached))
    file_total=$declared
    not_run=$((not_run + missing))
    skipped+=("$t: $missing cases")
  fi
  # A failure that no case carries still counts once, so the summary never shows every case passing.
  if [ ${#failed[@]} -gt "$file_failures" ] && [ "$file_total" -eq "$passed" ]; then
    file_total=$((file_total + 1))
  fi
  pass=$((pass + passed))
  total=$((total + file_total))
done
echo "$pass of $total pass"
if [ "$not_run" -gt 0 ]; then
  echo "$not_run not run"
  printf 'not run: %s\n' "${skipped[@]}"
fi
if [ ${#failed[@]} -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
