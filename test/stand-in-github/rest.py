"""The REST face of the stand-in GitHub: the calls the Forge's owner requests and steps make, served from the same
state.json as the `gh` stand-in. Only what those handlers read is served, with only the fields they read.

Git refs are the local remote's own refs, so a tag or branch the Forge makes is really there. Any JWT of the right shape
is accepted and any installation token is honoured: this is a stand-in, the scenario's App key is generated for it.
"""
import base64
import fcntl
import json
import pathlib
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import github

SITE = "https://github.example"


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Refused(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def git(state, *args, check=True):
    result = subprocess.run(["git", f"--git-dir={state['remote']}", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise Refused(422, result.stderr.strip() or "git refused")
    return result.stdout.strip()


def ref_sha(state, ref):
    out = subprocess.run(["git", f"--git-dir={state['remote']}", "rev-parse", "--verify", "--quiet", f"refs/{ref}^{{commit}}"],
                         capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else None


def shown_issue(repo, item):
    number = item["number"]
    return {"number": number, "title": item["title"], "body": item["body"], "state": item["state"].lower(),
            "labels": [], "user": {"login": item.get("login", "someone-else"), "type": "User"},
            "created_at": item.get("createdAt", now()), "updated_at": item.get("createdAt", now()),
            "html_url": f"{SITE}/{repo}/issues/{number}"}


def shown_pull(repo, item):
    return {"number": item["number"], "title": item["title"], "body": item["body"],
            "state": "closed" if item["merged"] else item["state"].lower(),
            "merged_at": item.get("mergedAt"), "merge_commit_sha": item.get("mergeCommit"),
            "base": {"ref": item["baseRefName"]}, "head": {"ref": item["headRefName"]},
            "user": {"login": "scenario-builder[bot]", "type": "Bot"}, "created_at": item.get("createdAt", now()),
            "html_url": f"{SITE}/{repo}/pull/{item['number']}"}


def shown_release(repo, item):
    return {"id": item["id"], "tag_name": item["tagName"], "name": item["name"], "body": item["body"],
            "prerelease": item["isPrerelease"], "draft": item["isDraft"], "published_at": item.get("publishedAt", now()),
            "html_url": f"{SITE}/{repo}/releases/tag/{item['tagName']}"}


def page(rows, query):
    per = int(query.get("per_page", ["30"])[0])
    number = int(query.get("page", ["1"])[0])
    return rows[(number - 1) * per:number * per]


def app_of(authorization):
    """The App id a JWT names in its iss claim."""
    parts = authorization.removeprefix("Bearer ").split(".")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    return int(json.loads(base64.urlsafe_b64decode(padded))["iss"])


class Handler(BaseHTTPRequestHandler):
    lock = threading.Lock()
    root = None

    def log_message(self, *_):
        pass

    def reply(self, status, value=None):
        data = b"" if value is None else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length)) if length else {}

    def handle_any(self, method):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        payload = self.body() if method in ("POST", "PATCH") else {}
        with self.lock, open(self.root / "rest.lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            state = json.loads((self.root / "state.json").read_text())
            try:
                status, value = self.route(method, url.path, query, payload, state)
            except Refused as refusal:
                return self.reply(refusal.status, {"message": str(refusal)})
            github.write_state(self.root, state)
        self.reply(status, value)

    def route(self, method, path, query, payload, state):
        matched = re.fullmatch(r"/app/installations/(\d+)/access_tokens", path)
        if matched and method == "POST":
            self.require_app()
            return 201, {"token": f"ghs_standin_{matched.group(1)}", "expires_at": "2099-01-01T00:00:00Z"}
        matched = re.fullmatch(r"/repos/([^/]+)/([^/]+)(/.*)?", path)
        if not matched:
            return 404, {"message": "Not Found"}
        repo = f"{unquote(matched.group(1))}/{unquote(matched.group(2))}"
        rest = matched.group(3) or ""
        if rest == "/installation":
            return 200, {"id": self.require_app()}
        if not self.headers.get("authorization", "").startswith("Bearer "):
            return 401, {"message": "Bad credentials"}
        return self.repository(method, repo, rest, query, payload, state)

    def require_app(self):
        token = self.headers.get("authorization", "")
        if not token.startswith("Bearer ") or len(token.split(".")) != 3:
            raise Refused(401, "A JSON web token could not be decoded")
        return app_of(token)

    def repository(self, method, repo, rest, query, payload, state):
        if rest == "" and method == "GET":
            return 200, {"full_name": repo, "default_branch": "main"}
        for handler in (self.releases, self.refs, self.issues, self.pulls):
            answer = handler(method, repo, rest, query, payload, state)
            if answer:
                return answer
        matched = re.fullmatch(r"/commits/[^/]+/check-runs", rest)
        if matched and method == "GET":
            return 200, {"total_count": 0, "check_runs": []}
        return 404, {"message": "Not Found"}

    def releases(self, method, repo, rest, query, payload, state):
        items = state["releases"]
        for index, item in enumerate(items):
            item.setdefault("id", 1000 + index)
        if rest == "/releases/latest" and method == "GET":
            latest = [item for item in items if item["isLatest"]]
            return (200, shown_release(repo, latest[0])) if latest else (404, {"message": "Not Found"})
        if rest == "/releases" and method == "GET":
            return 200, page([shown_release(repo, item) for item in reversed(items)], query)
        if rest == "/releases" and method == "POST":
            if any(item["tagName"] == payload["tag_name"] for item in items):
                return 422, {"message": "Validation Failed"}
            tag = f"tags/{payload['tag_name']}"
            if ref_sha(state, tag) is None:
                target = payload.get("target_commitish") or "HEAD"
                sha = ref_sha(state, f"heads/{target}") or git(state, "rev-parse", "--verify", f"{target}^{{commit}}")
                git(state, "update-ref", f"refs/{tag}", sha)
            prerelease = bool(payload.get("prerelease"))
            make_latest = payload.get("make_latest")
            latest = make_latest == "true" or (make_latest in (None, "legacy") and not prerelease and not payload.get("draft"))
            item = {"id": 1000 + len(items), "tagName": payload["tag_name"], "name": payload.get("name", ""),
                    "body": payload.get("body", ""), "isPrerelease": prerelease, "isDraft": bool(payload.get("draft")),
                    "isLatest": latest, "publishedAt": now()}
            if latest:
                for current in items:
                    current["isLatest"] = False
            items.append(item)
            return 201, shown_release(repo, item)
        matched = re.fullmatch(r"/releases/tags/(.+)", rest)
        if matched and method == "GET":
            found = [item for item in items if item["tagName"] == unquote(matched.group(1))]
            return (200, shown_release(repo, found[0])) if found else (404, {"message": "Not Found"})
        matched = re.fullmatch(r"/releases/(\d+)", rest)
        if matched and method == "PATCH":
            found = [item for item in items if item["id"] == int(matched.group(1))]
            if not found:
                return 404, {"message": "Not Found"}
            item = found[0]
            for key, field in (("tag_name", "tagName"), ("name", "name"), ("body", "body"), ("prerelease", "isPrerelease"), ("draft", "isDraft")):
                if key in payload:
                    item[field] = payload[key]
            if payload.get("make_latest") == "true" and not item["isPrerelease"] and not item["isDraft"]:
                for current in items:
                    current["isLatest"] = False
                item["isLatest"] = True
            elif item["isPrerelease"] or item["isDraft"]:
                item["isLatest"] = False
            return 200, shown_release(repo, item)
        return None

    def refs(self, method, repo, rest, query, payload, state):
        matched = re.fullmatch(r"/git/ref/(.+)", rest)
        if matched and method == "GET":
            ref = unquote(matched.group(1))
            sha = ref_sha(state, ref)
            return (200, {"ref": f"refs/{ref}", "object": {"type": "commit", "sha": sha}}) if sha else (404, {"message": "Not Found"})
        if rest == "/git/refs" and method == "POST":
            ref = payload["ref"]
            if subprocess.run(["git", f"--git-dir={state['remote']}", "rev-parse", "--verify", "--quiet", ref],
                              capture_output=True).returncode == 0:
                return 422, {"message": "Reference already exists"}
            git(state, "update-ref", ref, payload["sha"])
            return 201, {"ref": ref, "object": {"type": "commit", "sha": payload["sha"]}}
        matched = re.fullmatch(r"/git/refs/(heads/.+)", rest)
        if matched and method == "PATCH":
            ref = f"refs/{unquote(matched.group(1))}"
            if ref_sha(state, ref[5:]) is None:
                return 422, {"message": "Reference does not exist"}
            git(state, "update-ref", ref, payload["sha"])
            return 200, {"ref": ref, "object": {"type": "commit", "sha": payload["sha"]}}
        return None

    def issues(self, method, repo, rest, query, payload, state):
        items = state["issues"]
        if rest == "/issues" and method == "GET":
            wanted = query.get("state", ["open"])[0]
            rows = [(item["number"], shown_issue(repo, item)) for item in items]
            rows += [(item["number"], {**shown_pull(repo, item), "pull_request": {"url": "stand-in"}}) for item in state["pullRequests"]]
            rows = [row for _, row in sorted(rows, key=lambda pair: pair[0], reverse=query.get("direction", [""])[0] == "desc")
                    if wanted == "all" or row["state"] == wanted]
            return 200, page(rows, query)
        if rest == "/issues" and method == "POST":
            number = len(items) + len(state["pullRequests"]) + 1
            item = {"number": number, "title": payload["title"], "body": payload.get("body", ""), "state": "OPEN",
                    "comments": [], "login": self.login(), "createdAt": now()}
            items.append(item)
            return 201, shown_issue(repo, item)
        matched = re.fullmatch(r"/issues/(\d+)", rest)
        if matched and method in ("GET", "PATCH"):
            found = [item for item in items if item["number"] == int(matched.group(1))]
            if not found:
                return 404, {"message": "Not Found"}
            if method == "PATCH" and "state" in payload:
                found[0]["state"] = payload["state"].upper()
            return 200, shown_issue(repo, found[0])
        matched = re.fullmatch(r"/issues/(\d+)/comments", rest)
        if matched:
            found = [item for item in items if item["number"] == int(matched.group(1))]
            if not found:
                return 404, {"message": "Not Found"}
            if method == "GET":
                return 200, page([{"id": index + 1, "body": c["body"], "user": {"login": c.get("login", "someone-else")}}
                                  for index, c in enumerate(found[0]["comments"])], query)
            if method == "POST":
                found[0]["comments"].append({"body": payload["body"], "login": self.login()})
                return 201, {"id": len(found[0]["comments"]), "body": payload["body"], "user": {"login": self.login()}}
        return None

    def login(self):
        installation = self.headers.get("authorization", "").rsplit("_", 1)[-1]
        return {"1": "scenario-builder[bot]", "2": "scenario-release[bot]"}.get(installation, "scenario-builder[bot]")

    def pulls(self, method, repo, rest, query, payload, state):
        items = state["pullRequests"]
        if rest == "/pulls" and method == "GET":
            wanted = query.get("state", ["open"])[0]
            base = query.get("base", [None])[0]
            rows = [shown_pull(repo, item) for item in items]
            return 200, page([row for row in rows if (wanted == "all" or row["state"] == wanted)
                              and (base is None or row["base"]["ref"] == base)], query)
        matched = re.fullmatch(r"/pulls/(\d+)", rest)
        if matched and method == "GET":
            found = [item for item in items if item["number"] == int(matched.group(1))]
            return (200, shown_pull(repo, found[0])) if found else (404, {"message": "Not Found"})
        return None

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PATCH(self):
        self.handle_any("PATCH")


def serve(root):
    Handler.root = root
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    (root / "rest.port.new").write_text(f"{server.server_address[1]}\n")
    (root / "rest.port.new").replace(root / "rest.port")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
