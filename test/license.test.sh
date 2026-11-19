#!/usr/bin/env bash
# The Forge is MIT licensed, copyright Michael Zelbel, and says that the license covers its own files
# only (Cole Medin's factory and Archon are downloaded from their own repositories, never carried).
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 3
test_case "LICENSE is the MIT license"
head -1 LICENSE | grep -qx "MIT License" || { echo "LICENSE is not the MIT license"; exit 1; }
test_case "LICENSE carries the copyright line"
grep -q "^Copyright (c) 2026 Michael Zelbel$" LICENSE || { echo "LICENSE lacks the copyright line"; exit 1; }
test_case "README says the license covers only the Forge's own files"
grep -q "not Cole Medin's factory or" README.md || { echo "README no longer says the license covers only the Forge's own files"; exit 1; }
echo "license ok"
