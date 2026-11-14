#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
gh="$PWD/test/stand-in-github/gh"
control="$PWD/test/stand-in-github/control"
remote="$root/remote.git"
work="$root/work"
git init -q --bare "$remote"
git clone -q "$remote" "$work"
git -C "$work" config user.name Scenario
git -C "$work" config user.email scenario@example.invalid
printf 'initial\n' >"$work/result.txt"
git -C "$work" add result.txt
git -C "$work" commit -qm initial
git -C "$work" branch -M main
git -C "$work" push -q origin main
git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
git -C "$work" checkout -qb feature
printf 'released\n' >"$work/result.txt"
git -C "$work" commit -qam release
git -C "$work" push -q origin feature

export STANDIN_GITHUB_STATE="$root/state-one"
"$control" init --remote "$remote"
issue=$("$gh" issue create --title "Owner question" --body "Choose one")
"$gh" issue comment "$issue" --body "The owner chose one"
"$gh" issue view "$issue" --json title,comments >"$root/issue.json"
grep -F 'The owner chose one' "$root/issue.json" >/dev/null

pr=$("$gh" pr create --title "Release" --body "Ready" --head feature --base main)
"$gh" pr merge "$pr"
"$gh" pr view "$pr" --json state,merged >"$root/pr.json"
grep -F '"state": "MERGED"' "$root/pr.json" >/dev/null
[ "$(git --git-dir="$remote" show main:result.txt)" = "released" ]

"$gh" release create v1 --title "Version one" --notes "Previous"
"$gh" release create v2 --title "Version two" --notes "Candidate" --prerelease
[ -n "$(git --git-dir="$remote" rev-parse refs/tags/v1)" ]
[ -n "$(git --git-dir="$remote" rev-parse refs/tags/v2)" ]
"$gh" release edit v2 --prerelease false --latest true
"$gh" release edit v1 --latest true
"$gh" release edit v2 --prerelease true --latest false
"$gh" release list --json tagName,isLatest,isPrerelease >"$root/releases.json"
grep -F '"tagName": "v1"' "$root/releases.json" >/dev/null
grep -F '"tagName": "v2"' "$root/releases.json" >/dev/null

export STANDIN_GITHUB_STATE="$root/state-two"
"$control" init --remote "file://$remote"
[ "$("$gh" issue list --json number)" = "[]" ]

set +e
STANDIN_GITHUB_STATE="$root/rejected" "$control" init --remote https://example.invalid/repo.git 2>"$root/remote-error"
remote_status=$?
"$gh" api /repos/example 2>"$root/unsupported"
unsupported_status=$?
set -e
[ "$remote_status" -ne 0 ]
[ "$unsupported_status" -ne 0 ]
grep -F "absolute local path" "$root/remote-error" >/dev/null
grep -F "unsupported command" "$root/unsupported" >/dev/null

echo "stand-in GitHub: pass"
