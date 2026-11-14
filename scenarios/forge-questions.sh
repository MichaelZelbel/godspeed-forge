#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

factory_asks_question() {
  scenario_fail "Forge question relay is missing"
}

assert_question_relayed_once() {
  assert_count /scenario/notices.txt "Reply" 1
  assert_contains /scenario/notices.txt "For example"
  assert_contains /scenario/notices.txt "Choose"
  if grep -Ei 'factory|archon|workflow|implementation' /scenario/notices.txt >/dev/null; then
    scenario_fail "The owner message contains an internal name"
  fi
}

assert_owner_answer_landed_once() {
  gh issue view 1 --json comments > /scenario/artifacts/question.json
  assert_count /scenario/artifacts/question.json "owner decision" 1
  assert_contains /scenario/artifacts/question.json "owner's words"
}

if [ "${1-}" = "--inside" ]; then
  codex login status >/scenario/artifacts/agent-status
  factory_asks_question
  assert_question_relayed_once
  assert_owner_answer_landed_once
else
  scenario_start forge-questions "$0"
fi
