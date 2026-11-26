#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. scenarios/support/common.sh

factory_asks_question() {
  scenario_forge_start
  cat >/scenario/artifacts/questions-issue.md <<'QUESTIONS'
### 1. Should people see their sample result on the first screen?

For example, when you open the sample today, the result is on the second screen. Choose where it should be shown.

- (a) On the first screen, right away
- (b) On the second screen, as it is now

Recommendation: (a)
Default: keep it on the second screen.

### 2. How should the tests be organised?

Tests can live in one folder or beside the code.

- (a) One folder
- (b) Beside the code

Recommendation: (a)
Default: one folder.
QUESTIONS
  printf '%s\n' "How should the tests be organised?" >/scenario/build-only-questions.txt
  # What the factory's manager does: its own list of questions, and a stranger's look-alike that must stay unanswered.
  node /forge/scenarios/support/owner.mjs factory-issue "Owner decisions needed" /scenario/artifacts/questions-issue.md >/dev/null
  gh issue create --title "Owner decisions needed" --body "$(cat /scenario/artifacts/questions-issue.md)" >/dev/null
  node /forge/bin/godspeed-forge.mjs driver step owner-questions --settings-dir "$HOME/settings" \
    >/scenario/artifacts/owner-questions-step.json
  scenario_notices
  scenario_owner_says answer "F1 Show it on the first screen, right away." '{"handle":"F1"}' \
    >/scenario/artifacts/answer.json
  assert_contains /scenario/artifacts/answer.json '"ok":true'
}

assert_question_relayed_once() {
  assert_count /scenario/notices.txt "Reply" 1
  assert_contains /scenario/notices.txt "For example"
  assert_contains /scenario/notices.txt "Choose"
  if grep -Ei 'factory|archon|workflow|implementation' /scenario/notices.txt >/dev/null; then
    scenario_fail "The owner message contains an internal name"
  fi
  if grep -Ff /scenario/build-only-questions.txt /scenario/notices.txt >/dev/null; then
    scenario_fail "A build question reached the owner"
  fi
}

assert_owner_answer_landed_once() {
  gh issue view 1 --json comments > /scenario/artifacts/question.json
  assert_count /scenario/artifacts/question.json "Owner decision (question 1:" 1
  assert_contains /scenario/artifacts/question.json "Show it on the first screen, right away."
  if gh issue view 2 --json comments | grep -iF "owner decision" >/dev/null; then
    scenario_fail "The owner answer landed on the wrong question"
  fi
}

if [ "${1-}" = "--inside" ]; then
  codex login status >/scenario/artifacts/agent-status
  factory_asks_question
  assert_question_relayed_once
  assert_owner_answer_landed_once
else
  scenario_start forge-questions "$0"
fi
