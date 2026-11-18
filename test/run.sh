#!/usr/bin/env bash
# The Forge's whole test, as the `required` check and the factory's harness run it.
# Every file test/*.test.sh runs with bash and every test/*.test.mjs with node. Each file marks its cases
# (test/cases.sh, test/cases.mjs) and prints "case passed: <name>" or "case failed: <name>" for each.
# Prints "<n> of <m> pass" counting cases across all files (the factory's harness reads that line), and
# exits 1, naming the file and the case, when any case fails, a file fails outside a case, or a file
# reports no cases.
set -u
cd "$(dirname "$0")/.."
pass=0
total=0
failed=()
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
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
  pass=$((pass + passed))
  total=$((total + passed + failing))
  while IFS= read -r name; do failed+=("$t: $name"); done < <(sed -n 's/^case failed: //p' "$output")
  if [ "$status" -ne 0 ] && [ "$failing" -eq 0 ]; then
    total=$((total + 1))
    failed+=("$t: outside any case (exit $status)")
  elif [ "$status" -eq 0 ] && [ "$passed" -eq 0 ]; then
    total=$((total + 1))
    failed+=("$t: reported no cases")
  fi
done
echo "$pass of $total pass"
if [ ${#failed[@]} -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
