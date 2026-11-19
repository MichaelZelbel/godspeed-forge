#!/usr/bin/env bash
# test/run.sh itself: a file that fails at an early case keeps the full total and says how many cases
# were not run, and a file whose stated case count is wrong fails the run.
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 5
scratch="$(mktemp -d)"
trap 'test_cases_end; rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM

# A scratch copy of the runner and its case helpers in $1/test, with no test files yet.
runner() {
  mkdir -p "$1/test"
  cp test/run.sh test/cases.sh test/cases.mjs "$1/test/"
}
node_file() { # <path> <declared> <cases> [failing case]
  {
    echo "import { testCase } from './cases.mjs';"
    echo "// test cases: $2"
    for i in $(seq 1 "$3"); do
      echo "testCase('case $i');"
      if [ "$i" = "${4:-}" ]; then echo "throw new Error('case $i broke');"; fi
    done
  } >"$1"
}
expect() { # <file> <exact line>
  grep -qxF -- "$2" "$1" || { echo "expected the line: $2"; cat "$1"; exit 1; }
}
refuse() { # <file> <pattern>
  if grep -qE -- "$2" "$1"; then echo "did not expect: $2"; cat "$1"; exit 1; fi
}

test_case "a passing run prints one total and exits 0"
runner "$scratch/pass"
node_file "$scratch/pass/test/a.test.mjs" 5 5
printf '#!/usr/bin/env bash\nset -eu\n. test/cases.sh\n# test cases: 2\ntest_case one\ntest_case two\n' >"$scratch/pass/test/b.test.sh"
status=0; bash "$scratch/pass/test/run.sh" >"$scratch/pass.out" 2>&1 || status=$?
[ "$status" -eq 0 ] || { echo "passing run exited $status"; cat "$scratch/pass.out"; exit 1; }
expect "$scratch/pass.out" "7 of 7 pass"
[ "$(grep -cE '^[0-9]+ of [0-9]+ pass$' "$scratch/pass.out")" -eq 1 ] || { echo "not exactly one summary line"; exit 1; }
refuse "$scratch/pass.out" 'not run|^failed: '

test_case "a node file failing at an early case keeps its full total and counts the rest as not run"
runner "$scratch/early"
node_file "$scratch/early/test/a.test.mjs" 5 5 2
printf '#!/usr/bin/env bash\nset -eu\n. test/cases.sh\n# test cases: 2\ntest_case one\ntest_case two\n' >"$scratch/early/test/b.test.sh"
status=0; bash "$scratch/early/test/run.sh" >"$scratch/early.out" 2>&1 || status=$?
[ "$status" -eq 1 ] || { echo "failing run exited $status"; cat "$scratch/early.out"; exit 1; }
expect "$scratch/early.out" "3 of 7 pass"
expect "$scratch/early.out" "3 not run"
expect "$scratch/early.out" "not run: test/a.test.mjs: 3 cases"
expect "$scratch/early.out" "failed: test/a.test.mjs: case 2"

test_case "a failure before any case still fails the run without changing the total"
runner "$scratch/outside"
printf "import './cases.mjs';\n// test cases: 3\nthrow new Error('broke first');\n" >"$scratch/outside/test/a.test.mjs"
status=0; bash "$scratch/outside/test/run.sh" >"$scratch/outside.out" 2>&1 || status=$?
[ "$status" -eq 1 ] || { echo "run exited $status"; cat "$scratch/outside.out"; exit 1; }
expect "$scratch/outside.out" "0 of 3 pass"
expect "$scratch/outside.out" "3 not run"
expect "$scratch/outside.out" "failed: test/a.test.mjs: outside any case (exit 1)"

test_case "a file that reports no cases still fails the run"
runner "$scratch/none"
printf "// test cases: 0\nconsole.log('nothing here');\n" >"$scratch/none/test/a.test.mjs"
status=0; bash "$scratch/none/test/run.sh" >"$scratch/none.out" 2>&1 || status=$?
[ "$status" -eq 1 ] || { echo "run exited $status"; cat "$scratch/none.out"; exit 1; }
expect "$scratch/none.out" "0 of 1 pass"
expect "$scratch/none.out" "failed: test/a.test.mjs: reported no cases"

test_case "a file whose stated case count is wrong, or missing, fails the run"
runner "$scratch/count"
node_file "$scratch/count/test/a.test.mjs" 4 5
node_file "$scratch/count/test/b.test.mjs" 2 2
sed -i '/test cases:/d' "$scratch/count/test/b.test.mjs"
status=0; bash "$scratch/count/test/run.sh" >"$scratch/count.out" 2>&1 || status=$?
[ "$status" -eq 1 ] || { echo "run exited $status"; cat "$scratch/count.out"; exit 1; }
expect "$scratch/count.out" "7 of 9 pass"
expect "$scratch/count.out" "failed: test/a.test.mjs: says it has 4 cases but ran 5"
expect "$scratch/count.out" 'failed: test/b.test.mjs: does not say how many cases it has (add a "test cases: <n>" comment line)'
