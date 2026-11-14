#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
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
printf '%s\n' "$scenario_root" >>"$FAKE_DOCKER_LOG"
case "$script" in
  forge-setup.sh) echo "Forge setup command is missing" ;;
  forge-one-release.sh) echo "Forge plan-release command is missing" ;;
  forge-questions.sh) echo "Forge question relay is missing" ;;
  *) exit 64 ;;
esac
exit 1
EOF
chmod +x "$root/bin/docker"

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
expected='FAIL forge-setup: Forge setup command is missing
FAIL forge-one-release: Forge plan-release command is missing
FAIL forge-questions: Forge question relay is missing
0 of 3 pass'
[ "$(cat "$root/one.out")" = "$expected" ]
[ "$(cat "$root/two.out")" = "$expected" ]
[ "$(wc -l <"$root/docker.log")" -eq 6 ]
[ "$(sort -u "$root/docker.log" | wc -l)" -eq 6 ]

printf '{"github_token":"ghp_live_value"}\n' >"$root/config.json"
set +e
( . scenarios/support/common.sh; assert_no_secrets "$root/config.json" ) >"$root/secret.out"
secret_status=$?
set -e
[ "$secret_status" -ne 0 ]
grep -F "A key or token was written" "$root/secret.out" >/dev/null

echo "scenarios: pass"
