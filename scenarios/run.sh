#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."

pass=0
total=0
for scenario in forge-setup forge-one-release forge-questions; do
  total=$((total + 1))
  output=$(mktemp)
  errors=$(mktemp)
  if bash "scenarios/$scenario.sh" >"$output" 2>"$errors"; then
    if [ "$(wc -l <"$output")" -eq 0 ]; then
      echo "PASS $scenario"
      pass=$((pass + 1))
    else
      echo "FAIL $scenario: unexpected scenario output"
    fi
  else
    reason=$(tail -n 1 "$output" | tr -d '\r')
    if [ -z "$reason" ]; then
      reason=$(grep -v '^[[:space:]]*$' "$errors" | tail -n 1 | tr -d '\r' || true)
    fi
    if [ -z "$reason" ]; then
      reason="scenario failed without a reason"
    fi
    echo "FAIL $scenario: $reason"
  fi
  rm -f "$output" "$errors"
done
echo "$pass of $total pass"
[ "$pass" -eq "$total" ]
