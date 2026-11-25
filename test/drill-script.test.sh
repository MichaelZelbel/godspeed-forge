#!/usr/bin/env bash
# The standstill drill's scripts (scripts/drill-standstill.sh and its fast helper). The drill itself needs a throwaway
# machine with systemd, so the ordinary checks cannot run it; they check what they can without it: that the scripts parse, that
# fast is the default of `run` and the one-hour run is only an option, that both scenarios exist, and that reset empties the notice
# queue and check counts only notices written after minute 0 (the 0.3.1 rerun reported two notices, one from the drill before).
# The same standstills run in whole driver rounds, without a machine, in driver/test/test-release-clock-always.mjs.
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 4
test_case "the drill scripts parse"
bash -n scripts/drill-standstill.sh
node --check scripts/drill-standstill-fast.mjs
test_case "run is the fast drill by default; the real-time hour is an option for the one final check"
grep -q 'do_install "\$@"; do_fast' scripts/drill-standstill.sh || { echo "run no longer runs the fast drill"; exit 1; }
grep -q -- '--real-time' scripts/drill-standstill.sh || { echo "the real-time run is gone"; exit 1; }
test_case "both scenarios are in the drill"
grep -q 'beta31' scripts/drill-standstill.sh && grep -q 'release-first' scripts/drill-standstill.sh || { echo "a scenario is missing"; exit 1; }
test_case "reset empties the notice queue and check counts only notices after minute 0"
grep -q 'rm -f "\$NOTICES"' scripts/drill-standstill.sh || { echo "reset leaves the notice queue"; exit 1; }
grep -q 'w >= t0' scripts/drill-standstill.sh || { echo "check counts notices from before minute 0"; exit 1; }
echo "drill script ok"
