// The stand-in for `ssh godspeed-archon bash -s` that the self-tests of stage-server, staging-check, status,
// freeze and promote run against (STAGING_SSH_SCRIPT). It reads the script on standard input,
// answers by the name on its first line (# godspeed-staging: <name>) from a JSON state file
// (STAGING_STANDIN_STATE), changes that state the way the real server would change, and appends
// every call, script and all, to STAGING_STANDIN_CALLS. It never runs the script. Node's own modules
// only; nothing here talks to the network.
import fs from "node:fs";
import { createHash } from "node:crypto";

const statePath = process.env.STAGING_STANDIN_STATE;
const callsPath = process.env.STAGING_STANDIN_CALLS;
const script = fs.readFileSync(0, "utf8");
const op = (script.match(/^# godspeed-staging: (\S+)/m) || [])[1] || "unknown";
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(callsPath, `${JSON.stringify({ op, host: process.argv[2], command: process.argv.slice(3).join(" "), script })}\n`);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
const say = (s) => process.stdout.write(s);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const param = (name) => (script.match(new RegExp(`^# param ${name}=(.*)$`, "m")) || [])[1] || "";
const payload = () => {
  const m = script.match(/printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : "";
};

if (state.unreachable) {
  process.stderr.write("ssh: connect to host godspeed-archon port 22: Connection timed out\n");
  process.exit(255);
}

switch (op) {
  case "look":
    say(
      [
        `now=${state.now}`,
        `host=${state.host}`,
        `version=${state.commit}`,
        `version_since=${state.commitSince}`,
        `previous=${state.previous}`,
        `stage_ref=${state.stageRef}`,
        `installing=${state.installing}`,
        `health=${state.health ? JSON.stringify(state.health) : ""}`,
        `model_command=${(state.addonAi && state.addonAi.command) || ""}`,
        `pin=${state.pin ? Buffer.from(`${JSON.stringify(state.pin)}\n`).toString("base64") : ""}`,
        `follow=${state.follow ? Buffer.from(`${JSON.stringify(state.follow)}\n`).toString("base64") : ""}`,
      ].join("\n") + "\n",
    );
    break;
  // The add-ons' AI check (staging.mjs, addonAi): godspeed-model --describe, then a one-word request,
  // asked once more when it fails, as the real script does. state.addonAi says what each answers:
  // {command, describe: {code, out, err}, ask: [{code, out, err}, ...the second try], unreachable}.
  case "addon-ai": {
    const a = state.addonAi || { command: "" };
    state.addonAiChecks = (state.addonAiChecks || 0) + 1;
    save();
    if (a.unreachable) {
      process.stderr.write("ssh: connect to host godspeed-archon port 22: Connection timed out\n");
      process.exit(255);
    }
    const b64 = (s) => Buffer.from(String(s || "")).toString("base64");
    const lines = [`command=${a.command || ""}`];
    if (a.command) {
      const d = a.describe || { code: 0, out: "", err: "" };
      lines.push(`describe_exit=${d.code}`, `describe_out=${b64(d.out)}`, `describe_err=${b64(d.err)}`);
      if (d.code === 0) {
        const answers = a.ask || [];
        let tries = 1;
        let answer = answers[0] || { code: 0, out: "", err: "" };
        if (answer.code !== 0) {
          tries = 2;
          answer = answers[1] || answer;
        }
        lines.push(`ask_exit=${answer.code}`, `ask_tries=${tries}`, `ask_out=${b64(answer.out)}`, `ask_err=${b64(answer.err)}`);
      }
    }
    say(`${lines.join("\n")}\n`);
    break;
  }
  case "install":
    // An install that cannot start: another one is running (the script's own guard), or curl failed.
    if (state.installStartFails) {
      process.stderr.write(`${state.installStartFails}\n`);
      process.exit(3);
    }
    state.polls = 0;
    // Which commit this install is of, from the script's own "# param commit=" line.
    state.installingCommit = param("commit");
    state.installed = [...(state.installed || []), state.installingCommit];
    save();
    say("started=4242\n");
    break;
  case "poll": {
    state.polls = (state.polls || 0) + 1;
    if (state.polls < (state.pollsBeforeDone || 1)) {
      save();
      say("exit=\nbackup=\ntail=\n");
      break;
    }
    // What an install of that commit turns the server into: state.installs[<commit>] when a test
    // names one per commit (follow-main.mjs installs one, and may go back to another), else installTo.
    const to = (state.installs && state.installs[state.installingCommit]) || state.installTo || { exit: 0 };
    // An installer that never finishes while it is waited for.
    if (to.never) {
      save();
      say("exit=\nbackup=\ntail=\n");
      break;
    }
    if (to.exit === 0) {
      state.previous = state.commit;
      state.commit = to.commit || state.installingCommit;
      state.health = { ...state.health, version: to.version, instance: to.instance };
      // What the install leaves of the add-ons' AI connection, when a test says it changes it.
      if (to.addonAi) state.addonAi = { ...state.addonAi, ...to.addonAi };
    }
    save();
    const tail = Buffer.from("Building the screens\nThe last line the installer wrote\n").toString("base64");
    say(`exit=${to.exit}\nbackup=${to.exit === 0 ? state.backup : ""}\ntail=${tail}\n`);
    break;
  }
  case "write-stage": {
    state.files["stage.json"] = payload();
    const ref = (script.match(/^printf '%s\\n' '([^']+)' > "\$g\/stage-ref"$/m) || [])[1] || "";
    state.files["stage-ref"] = `${ref}\n`;
    state.stageRef = ref;
    save();
    say(`stage_sha256=${sha256(state.files["stage.json"])}\nstage_ref=${ref}\n`);
    break;
  }
  case "tell": {
    const field = (name) => {
      const m = script.match(new RegExp(`^${name}=\\$\\(printf '%s' '([A-Za-z0-9+/=]*)' \\| base64 -d\\)$`, "m"));
      return m ? Buffer.from(m[1], "base64").toString("utf8") : null;
    };
    const exit = state.tellExit === undefined ? 0 : state.tellExit;
    state.told = [...(state.told || []), { summary: field("summary"), status: field("status"), act: field("act"), sent: exit === 0, notify: (() => { const m = script.match(/^notify_cmd='(.+)'$/m); return m ? `${m[1]} --summary "$summary" --status "$status" --act "$act"` : ""; })() }];
    save();
    say(`notify_exit=${exit}\n`);
    break;
  }
  // The pin (staging.mjs, pinScript and unpinScript).
  case "pin":
    if (state.pinFails) {
      process.stderr.write("mkdir: cannot create directory: No space left on device\n");
      process.exit(1);
    }
    state.pin = JSON.parse(payload());
    save();
    say(`pin=${Buffer.from(payload()).toString("base64")}\n`);
    break;
  case "unpin": {
    const v = param("version");
    if (!state.pin) say("unpinned=none\n");
    else if (state.pin.version === v) {
      state.pin = null;
      say("unpinned=yes\n");
    } else say(`unpinned=other\npin=${Buffer.from(JSON.stringify(state.pin)).toString("base64")}\n`);
    save();
    break;
  }
  // The chat with the assistant (staging.mjs, chatScript): state.chat is null for no chat database,
  // or {quietSeconds, openTurns, unreadable}; left out, the chat has been quiet for an hour.
  case "chat": {
    const c = state.chat === undefined ? { quietSeconds: 3600, openTurns: 0 } : state.chat;
    if (c === null) say("chat=none\n");
    else if (c.unreadable) {
      process.stderr.write("sqlite3.OperationalError: database is locked\n");
      process.exit(1);
    } else say(`chat=yes\nquiet_seconds=${c.quietSeconds === null ? "" : c.quietSeconds}\nopen_turns=${c.openTurns || 0}\n`);
    break;
  }
  // follow-main.mjs's record (staging.mjs, followRecordScript).
  case "follow-record":
    state.follow = JSON.parse(payload());
    if (param("installed_main") === "yes") {
      state.stageRef = "main";
      state.files["stage-ref"] = "main\n";
      delete state.files["stage.json"];
    }
    save();
    say("recorded=yes\n");
    break;
  // follow-main.mjs --install-timer: the files it writes, by path.
  case "install-follower": {
    const files = {};
    for (const m of script.matchAll(/^printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d > (\S+)$/gm)) files[m[2]] = Buffer.from(m[1], "base64").toString("utf8");
    state.follower = { files, enabled: true };
    save();
    say("installed=yes\nnext=Tue 2026-10-27 12:10:00 UTC\n");
    break;
  }
  case "write-status":
    state.files["latest.json"] = payload();
    save();
    say("committed=yes\n");
    break;
  default:
    process.stderr.write(`the stand-in server does not know the command ${op}\n`);
    process.exit(2);
}
