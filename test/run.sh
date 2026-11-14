#!/usr/bin/env bash
# The Forge's whole test, as the `required` check and the factory's harness run it.
# Every file test/*.test.sh runs with bash and every test/*.test.mjs with node; each passes when it
# exits 0. Prints "<n> of <m> pass" (the factory's harness reads that line) and exits 1 when any fails.
set -u
cd "$(dirname "$0")/.."
pass=0
total=0
failed=()
shopt -s nullglob
for t in test/*.test.sh test/*.test.mjs; do
  total=$((total + 1))
  echo "== $t"
  case "$t" in
    *.sh) bash "$t" ;;
    *.mjs) node "$t" ;;
  esac
  if [ $? -eq 0 ]; then pass=$((pass + 1)); else failed+=("$t"); fi
done
echo "$pass of $total pass"
if [ ${#failed[@]} -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
