#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. test/cases.sh
# test cases: 5

root=$(mktemp -d)
trap 'test_cases_end; rm -rf "$root"' EXIT
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

test_case "issues and comments are kept in the stand-in state"
export STANDIN_GITHUB_STATE="$root/state-one"
ln -s "$remote" "$root/container-remote.git"
"$control" init --remote "$remote" --runtime-remote "$root/container-remote.git"
issue=$("$gh" issue create --title "Owner question" --body "Choose one")
"$gh" issue comment "$issue" --body "The owner chose one"
"$gh" issue view "$issue" --json title,comments >"$root/issue.json"
grep -F 'The owner chose one' "$root/issue.json" >/dev/null

test_case "a pull request merges into the local remote"
pr=$("$gh" pr create --title "Release" --body "Ready" --head feature --base main)
"$gh" pr merge "$pr"
"$gh" pr view "$pr" --json state,merged >"$root/pr.json"
grep -F '"state": "MERGED"' "$root/pr.json" >/dev/null
[ "$(git --git-dir="$remote" show main:result.txt)" = "released" ]

test_case "releases keep their prerelease and latest marks"
"$gh" release create v1 --title "Version one" --notes "Previous"
"$gh" release create v2 --title "Version two" --notes "Candidate" --prerelease
[ -n "$(git --git-dir="$remote" rev-parse refs/tags/v1)" ]
[ -n "$(git --git-dir="$remote" rev-parse refs/tags/v2)" ]
"$gh" release edit v2 --prerelease false --latest true
release_v1=$("$gh" release view v1 --json isPrerelease,isLatest)
release_v2=$("$gh" release view v2 --json isPrerelease,isLatest)
[ "$release_v1" = '{"isLatest": false, "isPrerelease": false}' ]
[ "$release_v2" = '{"isLatest": true, "isPrerelease": false}' ]
"$gh" release edit v1 --latest true
"$gh" release edit v2 --prerelease true --latest false
release_v1=$("$gh" release view v1 --json isPrerelease,isLatest)
release_v2=$("$gh" release view v2 --json isPrerelease,isLatest)
[ "$release_v1" = '{"isLatest": true, "isPrerelease": false}' ]
[ "$release_v2" = '{"isLatest": false, "isPrerelease": true}' ]
"$gh" release list --json tagName,isLatest,isPrerelease >"$root/releases.json"
grep -F '"tagName": "v1"' "$root/releases.json" >/dev/null
grep -F '"tagName": "v2"' "$root/releases.json" >/dev/null

test_case "the REST face serves the Forge's calls from the same state, with real refs"
"$PWD/test/stand-in-github/gh" serve &
serve_pid=$!
trap 'kill "$serve_pid" 2>/dev/null || true; test_cases_end; rm -rf "$root"' EXIT
for _ in $(seq 100); do [ -f "$root/state-one/rest.port" ] && break; sleep 0.1; done
python3 -I - "$root/state-one/rest.port" "$remote" "$gh" <<'PY'
import base64, json, subprocess, sys, urllib.request, urllib.error
port = open(sys.argv[1]).read().strip()
remote, gh = sys.argv[2], sys.argv[3]
base = f"http://127.0.0.1:{port}"
def part(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
jwt = f"{part({'alg': 'RS256'})}.{part({'iss': '1'})}.signature"
def call(method, path, body=None, token=None):
    request = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode() or "null")
status, found = call("GET", "/repos/o/r/installation", token=jwt)
assert (status, found["id"]) == (200, 1), (status, found)
status, minted = call("POST", "/app/installations/1/access_tokens", {"repositories": ["r"]}, jwt)
token = minted["token"]
assert status == 201 and token, minted
assert call("GET", "/repos/o/r/installation", token="not-a-jwt")[0] == 401
status, issue = call("POST", "/repos/o/r/issues", {"title": "From REST", "body": "Body"}, token)
assert status == 201 and issue["user"]["login"] == "scenario-builder[bot]", issue
assert call("POST", f"/repos/o/r/issues/{issue['number']}/comments", {"body": "Said"}, token)[0] == 201
shown = json.loads(subprocess.run([gh, "issue", "view", str(issue["number"]), "--json", "comments"], check=True, capture_output=True, text=True).stdout)
assert shown["comments"][0]["body"] == "Said", shown
assert call("GET", "/repos/o/r/releases/latest", token=token)[1]["tag_name"] == "v1"
status, made = call("POST", "/repos/o/r/releases", {"tag_name": "v3", "name": "3", "body": "n", "prerelease": True, "target_commitish": "main", "make_latest": "false"}, token)
assert status == 201 and made["prerelease"], made
assert call("GET", "/repos/o/r/releases/latest", token=token)[1]["tag_name"] == "v1"
assert call("GET", "/repos/o/r/git/ref/tags/v3", token=token)[0] == 200
main = call("GET", "/repos/o/r/git/ref/heads/main", token=token)[1]["object"]["sha"]
assert call("POST", "/repos/o/r/git/refs", {"ref": "refs/heads/staging", "sha": main}, token)[0] == 201
assert call("POST", "/repos/o/r/git/refs", {"ref": "refs/heads/staging", "sha": main}, token)[0] == 422
assert call("GET", "/repos/o/r/git/ref/heads/missing", token=token)[0] == 404
merged = call("GET", "/repos/o/r/pulls?state=closed&base=main", token=token)[1]
assert merged and merged[0]["merged_at"] and merged[0]["merge_commit_sha"] == subprocess.run(
    ["git", f"--git-dir={remote}", "rev-parse", "main"], check=True, capture_output=True, text=True).stdout.strip(), merged
PY
git --git-dir="$remote" rev-parse refs/heads/staging >/dev/null
kill "$serve_pid"

test_case "a new state starts empty and a remote that is not local is refused"
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
