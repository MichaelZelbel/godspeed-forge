# Marks where each test case of a bash test file begins, so test/run.sh can count cases, not files.
# Source it, then call `test_case <name>` at the start of each case. A case runs to the next one, or to
# the end of the file. Each case prints "case passed: <name>" once it ends, or "case failed: <name>" when
# the file stops inside it. A file with its own exit trap calls `test_cases_end` first in that trap.
# A file also states how many cases it has, in a line "# test cases: <n>", so test/run.sh can count
# the cases a failure kept from running.
test_case_current=""
test_case() {
  if [ -n "$test_case_current" ]; then echo "case passed: $test_case_current"; fi
  test_case_current="$1"
}
test_cases_end() {
  local status=$?
  if [ -n "$test_case_current" ]; then
    if [ "$status" -eq 0 ]; then echo "case passed: $test_case_current"; else echo "case failed: $test_case_current"; fi
    test_case_current=""
  fi
  return "$status"
}
trap test_cases_end EXIT
