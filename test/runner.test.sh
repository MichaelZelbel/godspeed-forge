#!/usr/bin/env bash
# test/run.sh itself: a file that fails at an early case keeps the full total and says how many cases
# were not run, a file whose stated case count is wrong fails the run, and a file that reaches for the
# network fails the run.
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 7
scratch="$(mktemp -d)"
trap 'test_cases_end; rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM

# A scratch copy of the runner and its case helpers in $1/test, with no test files yet.
runner() {
  mkdir -p "$1/test"
  cp test/run.sh test/cases.sh test/cases.mjs "$1/test/"
  cp -R test/offline "$1/test/"
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

# The network guard refuses before anything leaves this machine: git is allowed only local repositories,
# and node refuses the connection (and the name lookup) before making it.
test_case "a test that reaches for the network with git fails the run, even when it ignores the refusal"
runner "$scratch/git-network"
git init -q --bare "$scratch/git-network/local.git"
cat >"$scratch/git-network/test/a.test.sh" <<CASE
#!/usr/bin/env bash
set -eu
. test/cases.sh
# test cases: 2
test_case "a local repository is fine"
git ls-remote "$scratch/git-network/local.git" >/dev/null
test_case "a repository on GitHub is refused"
git ls-remote https://github.com/coleam00/ai-software-factory >/dev/null 2>&1 || true
git -c url.git@github.com:.insteadOf=gh: ls-remote gh:owner/repo >/dev/null 2>&1 || true
CASE
status=0; bash "$scratch/git-network/test/run.sh" >"$scratch/git-network.out" 2>&1 || status=$?
[ "$status" -eq 1 ] || { echo "run exited $status"; cat "$scratch/git-network.out"; exit 1; }
expect "$scratch/git-network.out" "2 of 3 pass"
expect "$scratch/git-network.out" "failed: test/a.test.sh: reached for the network: git ls-remote https://github.com/coleam00/ai-software-factory"
expect "$scratch/git-network.out" "failed: test/a.test.sh: reached for the network: git -c url.git@github.com:.insteadOf=gh: ls-remote gh:owner/repo"

test_case "a test that reaches for the network from node fails the run, and this machine is still allowed"
runner "$scratch/node-network"
cat >"$scratch/node-network/test/a.test.mjs" <<'CASE'
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { testCase } from './cases.mjs';
// test cases: 3
testCase('a server on this machine is fine');
const server = createServer(socket => socket.end('hello')).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const reply = await new Promise((resolve, reject) => {
  const socket = connect(server.address().port, '127.0.0.1');
  let data = '';
  socket.on('data', chunk => { data += chunk; }).on('end', () => resolve(data)).on('error', reject);
});
assert.equal(reply, 'hello');
server.close();
testCase('a fetch from GitHub is refused');
await assert.rejects(fetch('https://api.github.com/'));
testCase('a node process the test starts is guarded too');
try { execFileSync(process.execPath, ['-e', "require('node:net').connect(443, '192.0.2.1').on('error', () => {})"], { stdio: 'ignore' }); } catch {}
CASE
status=0; bash "$scratch/node-network/test/run.sh" >"$scratch/node-network.out" 2>&1 || status=$?
[ "$status" -eq 1 ] || { echo "run exited $status"; cat "$scratch/node-network.out"; exit 1; }
expect "$scratch/node-network.out" "3 of 4 pass"
grep -qE '^failed: test/a\.test\.mjs: reached for the network: connect to api\.github\.com:443 ' "$scratch/node-network.out" \
  || { echo "the fetch was not named"; cat "$scratch/node-network.out"; exit 1; }
grep -qE '^failed: test/a\.test\.mjs: reached for the network: connect to 192\.0\.2\.1:443 ' "$scratch/node-network.out" \
  || { echo "the child process was not named"; cat "$scratch/node-network.out"; exit 1; }
