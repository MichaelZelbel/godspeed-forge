#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 3

root=$(mktemp -d)
trap 'test_cases_end; rm -rf "$root"' EXIT
mkdir "$root/bin"
cat >"$root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "$1" = build ]; then
  echo scenario-test-image
  exit 0
fi
[ "$1" = run ]
shift
scenario_root=
script=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v)
      case "$2" in
        *:/scenario) scenario_root=${2%:/scenario} ;;
      esac
      shift 2
      ;;
    /forge/scenarios/*.sh)
      script=${1##*/}
      shift
      ;;
    *) shift ;;
  esac
done
[ -n "$scenario_root" ]
[ -n "$script" ]
python3 -c 'import json, sys; assert json.load(open(sys.argv[1]))["remote"] == "/scenario/remote.git"' \
  "$scenario_root/github/state.json"
[ "$(git --git-dir="$scenario_root/remote.git" symbolic-ref HEAD)" = refs/heads/main ]
printf '%s\n' "$scenario_root" >>"$FAKE_DOCKER_LOG"
case "$script" in
  forge-setup.sh) echo "Forge setup cannot run offline yet: creating its GitHub Apps calls https://api.github.com directly (lib/github-adapter.mjs)" ;;
  forge-one-release.sh) echo "The owner's go did not publish the release" ;;
  forge-questions.sh) echo "A build question reached the owner" >&2 ;;
  *) exit 64 ;;
esac
exit 1
EOF
chmod +x "$root/bin/docker"

test_case "two scenario runs at once each fail closed, naming the failing step"
export PATH="$root/bin:$PATH"
export FAKE_DOCKER_LOG="$root/docker.log"
set +e
bash scenarios/run.sh >"$root/one.out" &
one_pid=$!
bash scenarios/run.sh >"$root/two.out" &
two_pid=$!
wait "$one_pid"
one_status=$?
wait "$two_pid"
two_status=$?
set -e
[ "$one_status" -ne 0 ]
[ "$two_status" -ne 0 ]
test_case "each run reports the same three named failures and 0 of 3 pass"
expected='FAIL forge-setup: Forge setup cannot run offline yet: creating its GitHub Apps calls https://api.github.com directly (lib/github-adapter.mjs)
FAIL forge-one-release: The owner'"'"'s go did not publish the release
FAIL forge-questions: A build question reached the owner
0 of 3 pass'
[ "$(cat "$root/one.out")" = "$expected" ]
[ "$(cat "$root/two.out")" = "$expected" ]
[ "$(wc -l <"$root/docker.log")" -eq 6 ]
[ "$(sort -u "$root/docker.log" | wc -l)" -eq 6 ]

test_case "a key or token written into a scenario's files is caught"
printf '{"github_token":"ghp_live_value"}\n' >"$root/config.json"
set +e
( . scenarios/support/common.sh; assert_no_secrets "$root/config.json" ) >"$root/secret.out"
secret_status=$?
set -e
[ "$secret_status" -ne 0 ]
grep -F "A key or token was written" "$root/secret.out" >/dev/null

echo "scenarios: pass"
