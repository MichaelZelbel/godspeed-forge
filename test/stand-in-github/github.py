#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def die(message, status=64):
    print(f"stand-in gh: {message}", file=sys.stderr)
    raise SystemExit(status)


def state_root():
    value = os.environ.get("STANDIN_GITHUB_STATE")
    if not value:
        die("STANDIN_GITHUB_STATE is required")
    root = pathlib.Path(value)
    if not (root / "state.json").is_file():
        die("state has not been initialized", 66)
    return root


def read_state():
    root = state_root()
    return root, json.loads((root / "state.json").read_text())


def write_state(root, state):
    temporary = root / "state.json.new"
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(root / "state.json")


def local_remote(value):
    if value.startswith("file://"):
        value = value[7:]
    path = pathlib.Path(value)
    if not path.is_absolute():
        die("remote must be an absolute local path or file URL")
    return path


def find(items, number, kind):
    try:
        wanted = int(number)
    except ValueError:
        die(f"invalid {kind} number")
    for item in items:
        if item["number"] == wanted:
            return item
    die(f"{kind} {wanted} not found", 1)


def emit(value, fields=None):
    if fields:
        selected = fields.split(",")
        if isinstance(value, list):
            value = [{key: item.get(key) for key in selected} for item in value]
        else:
            value = {key: value.get(key) for key in selected}
    print(json.dumps(value, sort_keys=True))


def initialize(argv):
    parser = argparse.ArgumentParser(prog="stand-in-github control init")
    parser.add_argument("--remote", required=True)
    parser.add_argument("--runtime-remote")
    args = parser.parse_args(argv)
    remote = local_remote(args.remote).resolve()
    if not remote.is_dir():
        die("local remote does not exist", 66)
    root_value = os.environ.get("STANDIN_GITHUB_STATE")
    if not root_value:
        die("STANDIN_GITHUB_STATE is required")
    root = pathlib.Path(root_value)
    root.mkdir(parents=True, exist_ok=True)
    runtime_remote = local_remote(args.runtime_remote) if args.runtime_remote else remote
    write_state(root, {"remote": str(runtime_remote), "issues": [], "pullRequests": [], "releases": []})


def issue(argv):
    root, state = read_state()
    if not argv:
        die("issue operation is required")
    operation, args = argv[0], argv[1:]
    if operation == "create":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--title", required=True)
        parser.add_argument("--body", required=True)
        parsed = parser.parse_args(args)
        item = {"number": len(state["issues"]) + 1, "title": parsed.title, "body": parsed.body,
                "state": "OPEN", "comments": []}
        state["issues"].append(item)
        write_state(root, state)
        print(item["number"])
    elif operation == "list":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--json")
        parsed = parser.parse_args(args)
        emit(state["issues"], parsed.json)
    elif operation == "view":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("number")
        parser.add_argument("--json")
        parsed = parser.parse_args(args)
        emit(find(state["issues"], parsed.number, "issue"), parsed.json)
    elif operation == "comment":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("number")
        parser.add_argument("--body", required=True)
        parsed = parser.parse_args(args)
        item = find(state["issues"], parsed.number, "issue")
        item["comments"].append({"body": parsed.body})
        write_state(root, state)
    else:
        die("unsupported issue operation")


def pull_request(argv):
    root, state = read_state()
    if not argv:
        die("pr operation is required")
    operation, args = argv[0], argv[1:]
    if operation == "create":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--title", required=True)
        parser.add_argument("--body", required=True)
        parser.add_argument("--head", required=True)
        parser.add_argument("--base", required=True)
        parsed = parser.parse_args(args)
        item = {"number": len(state["pullRequests"]) + 1, "title": parsed.title, "body": parsed.body,
                "headRefName": parsed.head, "baseRefName": parsed.base, "state": "OPEN", "merged": False}
        state["pullRequests"].append(item)
        write_state(root, state)
        print(item["number"])
    elif operation == "view":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("number")
        parser.add_argument("--json")
        parsed = parser.parse_args(args)
        emit(find(state["pullRequests"], parsed.number, "pull request"), parsed.json)
    elif operation == "merge":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("number")
        parsed = parser.parse_args(args)
        item = find(state["pullRequests"], parsed.number, "pull request")
        if item["merged"]:
            die("pull request is already merged", 1)
        with tempfile.TemporaryDirectory() as directory:
            run = lambda *command: subprocess.run(command, cwd=directory, check=True,
                                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            run("git", "clone", state["remote"], ".")
            run("git", "config", "user.name", "Scenario GitHub")
            run("git", "config", "user.email", "scenario@example.invalid")
            run("git", "checkout", item["baseRefName"])
            run("git", "merge", "--no-ff", f"origin/{item['headRefName']}", "-m", f"Merge PR #{item['number']}")
            run("git", "push", "origin", item["baseRefName"])
        item["merged"] = True
        item["state"] = "MERGED"
        write_state(root, state)
    else:
        die("unsupported pr operation")


def release(argv):
    root, state = read_state()
    if not argv:
        die("release operation is required")
    operation, args = argv[0], argv[1:]
    if operation == "create":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("tag")
        parser.add_argument("--title", required=True)
        parser.add_argument("--notes", required=True)
        parser.add_argument("--prerelease", action="store_true")
        parsed = parser.parse_args(args)
        if any(item["tagName"] == parsed.tag for item in state["releases"]):
            die("release tag already exists", 1)
        tag_ref = f"refs/tags/{parsed.tag}"
        checked = subprocess.run(["git", "check-ref-format", tag_ref], stdout=subprocess.DEVNULL)
        if checked.returncode != 0:
            die("invalid release tag")
        remote_head = subprocess.run(
            ["git", f"--git-dir={state['remote']}", "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True
        ).stdout.strip()
        subprocess.run(
            ["git", f"--git-dir={state['remote']}", "update-ref", tag_ref, remote_head], check=True
        )
        item = {"tagName": parsed.tag, "name": parsed.title, "body": parsed.notes,
                "isPrerelease": parsed.prerelease, "isDraft": False, "isLatest": not parsed.prerelease}
        if item["isLatest"]:
            for current in state["releases"]:
                current["isLatest"] = False
        state["releases"].append(item)
        write_state(root, state)
    elif operation == "view":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("tag")
        parser.add_argument("--json")
        parsed = parser.parse_args(args)
        matches = [item for item in state["releases"] if item["tagName"] == parsed.tag]
        if not matches:
            die("release not found", 1)
        emit(matches[0], parsed.json)
    elif operation == "list":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--json")
        parsed = parser.parse_args(args)
        emit(state["releases"], parsed.json)
    elif operation == "edit":
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("tag")
        parser.add_argument("--latest", choices=["true", "false"])
        parser.add_argument("--prerelease", choices=["true", "false"])
        parsed = parser.parse_args(args)
        matches = [item for item in state["releases"] if item["tagName"] == parsed.tag]
        if not matches:
            die("release not found", 1)
        item = matches[0]
        if parsed.latest == "true":
            for current in state["releases"]:
                current["isLatest"] = False
            item["isLatest"] = True
        elif parsed.latest == "false":
            item["isLatest"] = False
        if parsed.prerelease is not None:
            item["isPrerelease"] = parsed.prerelease == "true"
        write_state(root, state)
    else:
        die("unsupported release operation")


def main():
    argv = sys.argv[1:]
    if argv[:2] == ["control", "init"]:
        initialize(argv[2:])
    elif argv and argv[0] == "issue":
        issue(argv[1:])
    elif argv and argv[0] == "pr":
        pull_request(argv[1:])
    elif argv and argv[0] == "release":
        release(argv[1:])
    else:
        die("unsupported command")


if __name__ == "__main__":
    main()
