// What a candidate's stay on the maintainer's own server is made of (process.md, section 7,
// condition 3): the server, the commands that run on it, the proving scenarios read from GitHub,
// and the two records in this repository that promote.mjs reads before it moves anything.
// stage-server.mjs, staging-check.mjs, record-go.mjs, status.mjs and promote.mjs share it. Node's
// own modules only, no npm packages.
//
// WHY (26 October 2026). The gate said a candidate runs on the maintainer's machines before the
// public gets it, and nothing enforced it: that morning 2.0.0-beta.7 was promoted while his server
// still ran 2.0.0-beta.6. Now the install on his server is a record that only the install and a
// check of the server write, the scenarios are read from their run on the candidate's own tag, his
// go is a record of his own words, and promote refuses without all three. That evening he dropped
// the whole night the candidate also had to spend there ("switch us to the simple version without
// the night"): there is no fixed waiting time of any kind, so an urgent fix takes the same path.
//
// The server is reached as `ssh <server>` (the settings' releases.server), each command a short bash script on standard input whose
// first line names it (# godspeed-staging: <name>). The self-tests replace ssh with a stand-in that
// answers by that name (STAGING_SSH_SCRIPT, a Node script, as RELEASE_TOKEN_SCRIPT replaces the
// token script).
//
// The records live in the records repository (the settings' releases.records_repo), on main, in the release's own folder:
//   releases/<release>/staging.json   what was put on the server, when, how it came up, what the
//                                     checks of the server since found, and the scenarios' result
//   releases/<release>/go.json        the maintainer's go: his words, verbatim, and when
// They are always read from origin/main after a fetch and written as one commit on top of it, pushed
// straight to main, so a checkout that is behind, on another branch or full of other work never
// holds a record nobody else sees, and is never touched. RELEASE_RECORDS_ROOT names the checkout
// (default: the one this file is in).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as R from "./release-api.mjs";
import { cfg, onConfigure } from "./config.mjs";

// The one repository that is put on the maintainer's server, and the server: all from the settings
// (config.mjs). The values are rebuilt whenever configure() is called.
export let PRODUCT_REPO = "";
export let SERVER = "";
export let GODSPEED_ON_SERVER = "";
export let RUNTIME_ON_SERVER = "";
export const HEALTH_URL_DEFAULT = "http://127.0.0.1:47831/health";
export let HEALTH_URL = HEALTH_URL_DEFAULT;
export let STAGING_ON_SERVER = "";
// While a frozen candidate waits for the maintainer's verdict, this file names it, and the server
// does not follow main (follow-main.mjs). stage-server.mjs writes it; promote.mjs and take-back.mjs
// remove it.
export let PIN_ON_SERVER = "";
// What follow-main.mjs last did there: the commit it installed, and a commit that failed there.
export let FOLLOW_STATE_ON_SERVER = "";
// The assistant's own database, where the chat with it is kept (godspeed-v2-gateway's HERMES_HOME).
export let CHAT_DB_ON_SERVER = "";
export const HEARTBEAT_MINUTES = 15;
// The product's proving scenarios (its .github/workflows/scenarios.yml); see scenarios() below.
export let SCENARIOS_WORKFLOW = "scenarios.yml";
function refresh() {
  PRODUCT_REPO = cfg.productRepo;
  SERVER = cfg.server;
  GODSPEED_ON_SERVER = cfg.godspeedOnServer;
  RUNTIME_ON_SERVER = `${GODSPEED_ON_SERVER}/.godspeed/integrated-runtime`;
  HEALTH_URL = cfg.healthUrl || HEALTH_URL_DEFAULT;
  STAGING_ON_SERVER = cfg.stagingOnServer;
  PIN_ON_SERVER = `${STAGING_ON_SERVER}/pin`;
  FOLLOW_STATE_ON_SERVER = `${STAGING_ON_SERVER}/follow-main.json`;
  CHAT_DB_ON_SERVER = `${RUNTIME_ON_SERVER}/hermes/state.db`;
  SCENARIOS_WORKFLOW = cfg.scenariosWorkflow || "scenarios.yml";
}
onConfigure(refresh);
refresh();

const lastLine = (s) => String(s || "").trim().split("\n").pop() || "";
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- versions ----------

// -1, 0 or 1, the way semantic versions order: 2.0.0-beta.7 < 2.0.0-beta.10 < 2.0.0.
export function compareVersions(a, b) {
  const split = (v) => {
    const s = String(v);
    const cut = s.indexOf("-");
    return { main: (cut < 0 ? s : s.slice(0, cut)).split(".").map(Number), pre: cut < 0 ? [] : s.slice(cut + 1).split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] || 0) !== (y.main[i] || 0)) return (x.main[i] || 0) < (y.main[i] || 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const nx = /^\d+$/.test(x.pre[i]);
    const ny = /^\d+$/.test(y.pre[i]);
    if (nx && ny && Number(x.pre[i]) !== Number(y.pre[i])) return Number(x.pre[i]) < Number(y.pre[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

// ---------- the date, in Berlin ----------

function berlinParts(ms) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

export function berlinDate(ms) {
  const p = berlinParts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------- the server ----------

const op = (name, params = {}) => [`# godspeed-staging: ${name}`, ...Object.entries(params).map(([k, v]) => `# param ${k}=${v}`)].join("\n");

// The same box under a second name (the settings' releases.server_route_suffix), for when the first times out.
// The first route that answers is kept for the rest of the command, so one command never talks to
// the server two ways, and an install is never started twice.
const routes = () => (cfg.serverRouteSuffix ? [SERVER, `${SERVER}${cfg.serverRouteSuffix}`] : [SERVER]);
let route = null;

// One script on the server, on standard input. Never throws: an unreachable server is an answer.
// On the server itself (STAGING_ON_SERVER_ITSELF=1, as follow-main.mjs runs there) the same script
// runs in a local bash instead of through ssh.
export function onServer(env, script, { timeoutMs = 180000 } = {}) {
  const standIn = env.STAGING_SSH_SCRIPT;
  if (!standIn && (env.STAGING_ON_SERVER_ITSELF === "1" || cfg.stagingOnServerItself)) {
    const p = spawnSync("bash", ["-s"], { input: script, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 << 20, env, cwd: "/root" });
    return { code: p.error ? -1 : p.status, stdout: p.stdout || "", stderr: p.stderr || "", error: p.error ? p.error.message : null, host: "localhost" };
  }
  let r = null;
  for (const host of route ? [route] : routes()) {
    const cmd = standIn ? process.execPath : "ssh";
    const args = standIn ? [standIn, host, "bash -s"] : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host, "bash -s"];
    const p = spawnSync(cmd, args, { input: script, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 << 20, env });
    r = { code: p.error ? -1 : p.status, stdout: p.stdout || "", stderr: p.stderr || "", error: p.error ? p.error.message : null, host };
    // 255 is ssh's own exit when it could not connect; anything else is the server's answer.
    if (r.code !== 255 && r.code !== -1) {
      route = host;
      break;
    }
    if (route) break;
  }
  return r;
}

const why = (r) => r.error || lastLine(r.stderr) || `exit ${r.code}`;

export function keyValues(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && /^[a-z0-9_]+$/.test(line.slice(0, i))) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// What the server says about itself: its clock, which product commit the notebook runs and since
// when, the stage it was installed from, whether an install is running, and the notebook's health.
export function lookScript() {
  return `${op("look")}
set -u
r=${RUNTIME_ON_SERVER}
echo "now=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host=$(hostname)"
echo "version=$(cat "$r/version" 2>/dev/null)"
echo "version_since=$(date -u -r "$r/version" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
echo "previous=$(cat "$r/previous-version" 2>/dev/null)"
echo "stage_ref=$(cat ${GODSPEED_ON_SERVER}/.godspeed/stage-ref 2>/dev/null)"
echo "installing=$(pgrep -f 'install-native-notebook.sh ${GODSPEED_ON_SERVER}' | wc -l)"
echo "health=$(curl -s -m 10 ${HEALTH_URL} | tr -d '\\n')"
${FIND_MODEL}
echo "model_command=$m"
echo "pin=$(base64 -w0 ${PIN_ON_SERVER} 2>/dev/null)"
echo "follow=$(base64 -w0 ${FOLLOW_STATE_ON_SERVER} 2>/dev/null)"
`;
}

const jsonOfB64 = (s) => {
  try {
    return s ? JSON.parse(Buffer.from(s, "base64").toString("utf8")) : null;
  } catch {
    return null;
  }
};

export function look(env) {
  const r = onServer(env, lookScript(), { timeoutMs: 60000 });
  if (r.code !== 0) return { reachable: false, why: why(r) };
  const kv = keyValues(r.stdout);
  if (!kv.now) return { reachable: false, why: `it answered without its clock (${lastLine(r.stdout) || "nothing"})` };
  let health = null;
  try {
    health = kv.health ? JSON.parse(kv.health) : null;
  } catch {
    health = null;
  }
  return {
    reachable: true,
    now: kv.now,
    host: kv.host || "",
    commit: kv.version || "",
    commitSince: kv.version_since || "",
    previous: kv.previous || "",
    stageRef: kv.stage_ref || "",
    installing: Number(kv.installing || 0),
    health,
    // The godspeed-model the add-ons' AI check would ask, or "" when there is none (addonAi, below).
    modelCommand: kv.model_command || "",
    // The candidate the server waits on (pinScript, below), or null; a pin that cannot be read
    // still pins, so the follower never moves past a candidate because its file was damaged.
    pin: kv.pin ? jsonOfB64(kv.pin) || { version: "(unreadable)" } : null,
    // What follow-main.mjs last recorded there, or null.
    follow: jsonOfB64(kv.follow),
  };
}

// The notebook's health in a few words, for a sentence.
export function healthWords(h) {
  if (!h) return "the notebook did not answer its health address";
  return `health ok=${h.ok}, version ${h.version}, instance ${h.instance}, scheduler heartbeat ${h.scheduler_heartbeat || "none"}`;
}

// How a version is put on the server (checked on 26 October 2026, exit 0, backup made, same
// instance kept): the product's own native installer at the candidate's commit, run as root on
// the product folder with Hermes' folder on PATH (without it the installer stops with "The original
// installer has not installed Hermes yet." and changes nothing) and GODSPEED_DIR unset. It builds
// the screens and takes several minutes, so it runs detached, writes its exit code beside its log,
// and is polled. The full public line (install-godspeed.sh) is not used here: its kit-bootstrap
// step would also reinstall the kit's own tools beside the maintainer's private engine.
export function installDir(version) {
  return `${STAGING_ON_SERVER}/${version}`;
}

export function installerUrl(ownerRepo, commit) {
  return `https://raw.githubusercontent.com/${ownerRepo}/${commit}/notebook/scripts/install-native-notebook.sh`;
}

export function installScript({ ownerRepo, version, commit }) {
  const dir = installDir(version);
  return `${op("install", { version, commit })}
set -eu
if pgrep -f 'install-native-notebook.sh ${GODSPEED_ON_SERVER}' > /dev/null; then echo "Another install is running on the server." >&2; exit 3; fi
dir=${dir}
mkdir -p "$dir"
rm -f "$dir/exit"
curl -fsSL ${installerUrl(ownerRepo, commit)} -o "$dir/install-native-notebook.sh"
cd /root
setsid nohup bash -c 'env -u GODSPEED_DIR PATH=/root/.local/bin:$PATH GODSPEED_PRODUCT_REF=${commit} GODSPEED_STARTER_REF=${commit} bash ${dir}/install-native-notebook.sh ${GODSPEED_ON_SERVER}; echo $? > ${dir}/exit' > "$dir/install.log" 2>&1 < /dev/null &
echo "started=$!"
`;
}

export function pollScript(version) {
  const dir = installDir(version);
  return `${op("poll", { version })}
set -u
dir=${dir}
if [ -f "$dir/exit" ]; then echo "exit=$(cat "$dir/exit")"; else echo "exit="; fi
echo "backup=$(sed -n 's/^A backup of your knowledge and media was made at: //p' "$dir/install.log" 2>/dev/null | tail -1)"
echo "tail=$(tail -n 8 "$dir/install.log" 2>/dev/null | base64 -w0)"
`;
}

// The stage file the candidate was installed from, as it was read, and the ref it was read from:
// what install-godspeed.sh leaves on every computer it installs.
export function writeStageScript({ version, stageText }) {
  const b64 = Buffer.from(stageText).toString("base64");
  return `${op("write-stage", { version })}
set -eu
g=${GODSPEED_ON_SERVER}/.godspeed
printf '%s' '${b64}' | base64 -d > "$g/stage.json.tmp"
mv -f "$g/stage.json.tmp" "$g/stage.json"
printf '%s\\n' 'candidate/${version}' > "$g/stage-ref"
echo "stage_sha256=$(sha256sum "$g/stage.json" | cut -d' ' -f1)"
echo "stage_ref=$(cat "$g/stage-ref")"
`;
}

export const installWait = (env) => ({
  poll: /^\d+$/.test(env.STAGING_POLL_MS || "") ? Number(env.STAGING_POLL_MS) : 20000,
  max: /^\d+$/.test(env.STAGING_INSTALL_MAX_MS || "") ? Number(env.STAGING_INSTALL_MAX_MS) : 45 * 60 * 1000,
});

// Installs <commit> the one way a version is put on the server (installScript) and waits for the
// installer's exit code; stage-server.mjs and follow-main.mjs both install this way. <version> only
// names the folder its log goes to. Never throws: {started: false, why} when it could not be
// started, {started: true, done: null, minutes} when it had not finished in time, and
// {started: true, done: {exit, backup, tail}} when it had.
export async function installAt(env, { ownerRepo, version, commit, log }) {
  const started = onServer(env, installScript({ ownerRepo, version, commit }), { timeoutMs: 180000 });
  if (started.code !== 0) return { started: false, why: why(started) };
  const pid = keyValues(started.stdout).started;
  log(`Started the installer on your server (${pid ? `process ${pid}` : "detached"}); it builds the screens, which takes several minutes.`);
  const { poll, max } = installWait(env);
  const since = Date.now();
  while (Date.now() - since <= max) {
    await sleep(poll);
    const p = onServer(env, pollScript(version), { timeoutMs: 60000 });
    if (p.code !== 0) {
      log(`  The server did not answer a poll (${why(p)}); asking again.`);
      continue;
    }
    const kv = keyValues(p.stdout);
    if (kv.exit !== undefined && kv.exit !== "") {
      return { started: true, done: { exit: Number(kv.exit), backup: kv.backup || "", tail: Buffer.from(kv.tail || "", "base64").toString("utf8").trim() } };
    }
  }
  return { started: true, done: null, minutes: Math.round(max / 60000) };
}

// The server after an install, against what it should be: the notebook healthy as <version> and as
// the same instance as <before>, its version file naming <commit>, and then the add-ons' AI
// connection (addonAi). Returns {after, problems, addonAi}: problems are clauses, none when healthy;
// addonAi is the AI check's answer with its time, or null when the notebook itself was not right.
export function checkAfter(env, { before, version, commit }) {
  const after = look(env);
  const problems = [];
  if (!after.reachable) problems.push(`your server could not be reached after the install (${after.why})`);
  else {
    if (!after.health || after.health.ok !== true) problems.push(`the notebook does not answer as healthy after the install (${healthWords(after.health)})`);
    else {
      if (after.health.version !== version) problems.push(`the notebook says version ${after.health.version}, not ${version}`);
      if (after.health.instance !== before.health.instance) problems.push(`the notebook says instance ${after.health.instance}, not ${before.health.instance} as before the install`);
    }
    if (after.commit !== commit) problems.push(`the notebook's version file names ${after.commit || "nothing"}, not ${commit}`);
  }
  let ai = null;
  if (!problems.length) {
    ai = { at: isoOf(Date.now()), ...addonAi(env) };
    const problem = addonAiProblem(ai, { hadCommand: !!before.modelCommand });
    if (problem) problems.push(problem);
  }
  return { after, problems, addonAi: ai };
}

// ---------- the pin, and following main ----------

// The pin: one line of JSON naming the candidate the server waits on, written before it is put there.
export function pinScript({ version, commit, tag, at }) {
  const b64 = Buffer.from(`${JSON.stringify({ version, commit, tag, at })}\n`).toString("base64");
  return `${op("pin", { version })}
set -eu
mkdir -p ${STAGING_ON_SERVER}
printf '%s' '${b64}' | base64 -d > ${PIN_ON_SERVER}.tmp
mv -f ${PIN_ON_SERVER}.tmp ${PIN_ON_SERVER}
echo "pin=$(base64 -w0 ${PIN_ON_SERVER})"
`;
}

// Removes the pin when it names <version>; a pin naming another candidate stays.
export function unpinScript({ version }) {
  return `${op("unpin", { version })}
set -u
p=${PIN_ON_SERVER}
if [ ! -f "$p" ]; then echo "unpinned=none"; exit 0; fi
if grep -qF '"version":"${version}"' "$p"; then rm -f "$p"; echo "unpinned=yes"; else echo "unpinned=other"; echo "pin=$(base64 -w0 "$p")"; fi
`;
}

// What removing the pin for <version> did, as a sentence. Never throws: promote.mjs and
// take-back.mjs have already changed what the public gets when they ask.
export function unpin(env, version) {
  const r = onServer(env, unpinScript({ version }), { timeoutMs: 60000 });
  const kv = keyValues(r.stdout);
  if (r.code !== 0 || !kv.unpinned) {
    return `The pin on your server could not be removed (${why(r)}), so it does not take new versions from main until it is: remove ${PIN_ON_SERVER} there.`;
  }
  if (kv.unpinned === "yes") return `Your server is no longer pinned to ${version}: it takes every new version merged into main again.`;
  if (kv.unpinned === "none") return `Your server was not pinned to ${version}, so it goes on taking every new version merged into main.`;
  const other = jsonOfB64(kv.pin);
  return `Your server stays pinned to ${(other && other.version) || "another candidate"}, which still waits; the pin was not for ${version}.`;
}

// Whether the chat with the assistant is in use: the newest message in the assistant's database and
// the replies being written now (open turn leases), read-only, as the night chat tidy-up reads them
// (the product's godspeed_routines.py, chat_state).
export const CHAT_QUIET_MINUTES = 10;
export function chatScript() {
  return `${op("chat")}
set -u
db=${CHAT_DB_ON_SERVER}
if [ ! -f "$db" ]; then echo "chat=none"; exit 0; fi
python3 -I - "$db" <<'PY'
import sqlite3, sys, time
from pathlib import Path
con = sqlite3.connect(Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True, timeout=30)
last = con.execute("select max(timestamp) from messages").fetchone()[0]
turns = con.execute("select count(*) from session_turn_leases where expires_at > ?", (time.time(),)).fetchone()[0]
print("chat=yes")
print("quiet_seconds=%s" % ("" if last is None else max(0, int(time.time() - float(last)))))
print("open_turns=%d" % turns)
PY
`;
}

// {quiet, why}: quiet only when no reply is being written and the newest message is at least
// CHAT_QUIET_MINUTES old. A chat that cannot be read counts as in use.
export function chat(env) {
  const r = onServer(env, chatScript(), { timeoutMs: 90000 });
  const kv = keyValues(r.stdout);
  if (r.code !== 0 || !kv.chat) return { quiet: false, why: `the chat could not be read (${why(r)})` };
  if (kv.chat === "none") return { quiet: true, why: "there is no chat on your server yet" };
  if (Number(kv.open_turns || 0) > 0) return { quiet: false, why: "a reply is being written in the chat" };
  if (!kv.quiet_seconds) return { quiet: true, why: "the chat holds no message yet" };
  const minutes = Math.floor(Number(kv.quiet_seconds) / 60);
  if (minutes < CHAT_QUIET_MINUTES) return { quiet: false, why: `the chat was used ${minutes} minute(s) ago, less than ${CHAT_QUIET_MINUTES}` };
  return { quiet: true, why: `the chat has been quiet for ${minutes} minutes and no reply is being written` };
}

// follow-main.mjs's record on the server. After an install from main, stage-ref says "main" and the
// candidate's stage file goes, since it would name another commit than the one that runs;
// stage-server.mjs writes both again when it puts a candidate there.
export function followRecordScript(state, { installedMain = false } = {}) {
  const b64 = Buffer.from(`${JSON.stringify(state, null, 2)}\n`).toString("base64");
  const g = `${GODSPEED_ON_SERVER}/.godspeed`;
  return `${op("follow-record", { installed_main: installedMain ? "yes" : "no" })}
set -eu
mkdir -p ${STAGING_ON_SERVER}
printf '%s' '${b64}' | base64 -d > ${FOLLOW_STATE_ON_SERVER}.tmp
mv -f ${FOLLOW_STATE_ON_SERVER}.tmp ${FOLLOW_STATE_ON_SERVER}
${installedMain ? `printf '%s\\n' main > ${g}/stage-ref\nrm -f ${g}/stage.json\n` : ""}echo "recorded=yes"
`;
}

// ---------- the AI connection the add-ons use ----------
//
// WHY (26 October 2026). 2.0.0-beta.7 came up on the server with the notebook healthy, as its
// version and the same instance, and was recorded as healthy; from that minute on no add-on reached
// the AI. The installer had recorded, as the Hermes that add-on requests go through, a launcher root
// cannot load. The notebook does not use it; godspeed-model, the one AI connection every add-on has,
// does, and the Wingman stopped at its evening session. So an install is healthy only if
// godspeed-model still names a configured AI and one tiny real request through it answers.
//
// Which godspeed-model: the one the product's installer writes into the Hermes home of this
// installation (beside it, as on the maintainer's server), then Hermes' default home, then root's
// PATH, then where the add-ons look. It is asked with --workspace <the product folder>, so it answers
// with this installation's connection. A Godspeed older than godspeed-model has none: that is said
// and is not a failure, unless one was there before and is gone.
const FIND_MODEL = `m=""
for c in ${RUNTIME_ON_SERVER}/hermes/bin/godspeed-model "\${HOME:-/root}/.hermes/bin/godspeed-model" "$(command -v godspeed-model 2>/dev/null)" "\${HOME:-/root}/.godspeed/bin/godspeed-model" /usr/local/bin/godspeed-model; do
  if [ -n "$c" ] && [ -x "$c" ]; then m=$c; break; fi
done`;

// The request is the smallest godspeed-model takes: it refuses max_tokens below 128 by design. A
// request that fails is asked once more after a pause, because an add-on may hold the connection's
// lock for a minute; only two failures in a row count.
export const MODEL_REQUEST = { system: "Answer with one word.", prompt: "Say OK.", timeout_ms: 60000, max_tokens: 128 };
const DESCRIBE_SECONDS = 90;
const ASK_SECONDS = 150;
const ASK_PAUSE_SECONDS = 20;

export function addonAiScript() {
  return `${op("addon-ai")}
set -u
${FIND_MODEL}
echo "command=$m"
if [ -z "$m" ]; then exit 0; fi
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
timeout ${DESCRIBE_SECONDS} "$m" --workspace ${GODSPEED_ON_SERVER} --describe < /dev/null > "$d/out" 2> "$d/err"
dc=$?
echo "describe_exit=$dc"
echo "describe_out=$(head -c 4000 "$d/out" | base64 -w0)"
echo "describe_err=$(head -c 2000 "$d/err" | base64 -w0)"
if [ "$dc" != 0 ]; then exit 0; fi
for try in 1 2; do
  printf '%s' '${JSON.stringify(MODEL_REQUEST)}' | timeout ${ASK_SECONDS} "$m" --workspace ${GODSPEED_ON_SERVER} > "$d/out" 2> "$d/err"
  ac=$?
  if [ "$ac" = 0 ] || [ "$try" = 2 ]; then break; fi
  sleep ${ASK_PAUSE_SECONDS}
done
echo "ask_exit=$ac"
echo "ask_tries=$try"
echo "ask_out=$(head -c 4000 "$d/out" | base64 -w0)"
echo "ask_err=$(head -c 2000 "$d/err" | base64 -w0)"
`;
}

const unb64 = (s) => Buffer.from(s || "", "base64").toString("utf8");
// The first thing a program said, as a clause: its first non-empty line, without a closing full stop.
const firstSaid = (s) => (String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "").replace(/[.\s]+$/, "").slice(0, 300);
const jsonObject = (s) => {
  try {
    const v = JSON.parse(String(s).trim());
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

// The add-ons' AI connection on the server, asked now. Never throws; one of
//   {state: "ok", command, provider, model, backup, tries}
//   {state: "absent"}                                   the server has no godspeed-model
//   {state: "failed", command, step, exit, detail}      step "describe" or "ask"; detail is the first
//                                                       line godspeed-model said, or what was wrong
//   {state: "unreachable", why}                         the server did not answer this check
export function addonAi(env) {
  const r = onServer(env, addonAiScript(), { timeoutMs: (DESCRIBE_SECONDS + 2 * ASK_SECONDS + ASK_PAUSE_SECONDS + 60) * 1000 });
  if (r.code !== 0) return { state: "unreachable", why: why(r) };
  const kv = keyValues(r.stdout);
  if (kv.command === undefined) return { state: "unreachable", why: `it answered without naming the godspeed-model it asked (${lastLine(r.stdout) || "nothing"})` };
  if (!kv.command) return { state: "absent" };
  const command = kv.command;
  const exitOf = (v) => (/^\d+$/.test(v || "") ? Number(v) : null);
  const failed = (step, exit, detail) => ({ state: "failed", command, step, exit, detail });

  const dExit = exitOf(kv.describe_exit);
  const dOut = unb64(kv.describe_out);
  if (dExit === null) return failed("describe", null, "the check on the server stopped before godspeed-model described its AI");
  if (dExit === 124) return failed("describe", dExit, `godspeed-model did not describe its AI within ${DESCRIBE_SECONDS} seconds`);
  if (dExit !== 0) return failed("describe", dExit, firstSaid(unb64(kv.describe_err)) || `godspeed-model --describe exited ${dExit} without saying why`);
  const d = jsonObject(dOut);
  if (!d) return failed("describe", 0, `godspeed-model --describe did not answer with JSON (${firstSaid(dOut) || "it printed nothing"})`);
  if (d.configured !== true || typeof d.provider !== "string" || !d.provider || typeof d.model !== "string" || !d.model) {
    return failed("describe", 0, `godspeed-model --describe names no configured AI (configured ${d.configured}, provider ${d.provider || "none"}, model ${d.model || "none"})`);
  }

  const aExit = exitOf(kv.ask_exit);
  const tries = exitOf(kv.ask_tries) || 1;
  if (aExit === null) return failed("ask", null, "the check on the server stopped before a one-word request through godspeed-model answered");
  if (aExit === 124) return { ...failed("ask", aExit, `a one-word request through godspeed-model got no answer within ${ASK_SECONDS} seconds`), tries };
  if (aExit !== 0) return { ...failed("ask", aExit, firstSaid(unb64(kv.ask_err)) || `a one-word request through godspeed-model exited ${aExit} without saying why`), tries };
  const a = jsonObject(unb64(kv.ask_out));
  if (!a || typeof a.text !== "string" || !a.text.trim()) return { ...failed("ask", 0, "a one-word request through godspeed-model came back without any text"), tries };
  return { state: "ok", command, provider: a.provider || d.provider, model: a.model || d.model, backup: a.backup === true, tries };
}

// What makes that answer not healthy, as a clause, or null. hadCommand: godspeed-model was there
// before (before the install, or at the install's own check), so none now is a failure.
export function addonAiProblem(ai, { hadCommand = false } = {}) {
  if (ai.state === "failed") return `the add-ons on your server cannot reach the AI: ${ai.detail}`;
  if (ai.state === "absent" && hadCommand) return "the add-ons on your server cannot reach the AI: godspeed-model, which was there before, is gone";
  if (ai.state === "unreachable") return `your server could not be reached to check the add-ons' AI connection (${ai.why})`;
  return null;
}

// What was checked, as a sentence, for an answer that is not a problem.
export function addonAiWords(ai) {
  if (ai.state === "absent") return "Your server has no godspeed-model (a Godspeed older than the add-ons' AI connection), so whether the add-ons reach the AI was not checked.";
  if (ai.state !== "ok") return `${addonAiProblem(ai, { hadCommand: true })}.`;
  return `The add-ons reach the AI: ${ai.command} names ${ai.provider} ${ai.model}, and a one-word request through it answered${ai.backup ? " through the backup AI, because the main one did not" : ""}${ai.tries > 1 ? ", on the second try" : ""}.`;
}

// ---------- telling the maintainer ----------

// The way a release message gets in front of the owner: the notify command of the settings when there is
// one (it takes --summary, --status and --act), otherwise Godspeed's own notice queue. Run on the server as
// root. The texts travel base64-encoded, so no quote in them can break the command.
export function tellScript({ summary, status, act }) {
  const b64 = (s) => Buffer.from(String(s)).toString("base64");
  return `${op("tell", { status })}
set -u
summary=$(printf '%s' '${b64(summary)}' | base64 -d)
status=$(printf '%s' '${b64(status)}' | base64 -d)
act=$(printf '%s' '${b64(act)}' | base64 -d)
notify_cmd='${cfg.notifyCommand}'
if [ -n "$notify_cmd" ] && [ -x "\${notify_cmd%% *}" ]; then
$notify_cmd --summary "$summary" --status "$status" --act "$act"
rc=$?
else
# Godspeed's own notice queue is the way a message reaches the owner (notebook core/notices.mjs).
# written:true says it as it is, once: the id is made from the text.
SUMMARY="$summary" ACT="$act" STATUS="$status" node -e '
const fs = require("fs"), crypto = require("crypto");
const file = process.env.STAGING_NOTICES_FILE || "${cfg.noticesFile || `${GODSPEED_ON_SERVER}/.godspeed/notices.json`}";
const text = process.env.SUMMARY + " " + process.env.ACT;
const id = "release-staging-" + crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
let notices = [];
if (fs.existsSync(file)) { const d = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(d.notices)) throw new Error("notices unreadable"); notices = d.notices; }
else if (!fs.existsSync(require("path").dirname(file))) throw new Error("no Godspeed here");
if (!notices.some((n) => n && n.id === id)) {
  notices.push({ id, text, at: new Date().toISOString(), about: process.env.STATUS, facts: [process.env.SUMMARY, process.env.ACT], written: true });
  fs.writeFileSync(file + "." + process.pid + ".tmp", JSON.stringify({ notices }, null, 2) + "\\n");
  fs.renameSync(file + "." + process.pid + ".tmp", file);
}
'
rc=$?
fi
echo "notify_exit=$rc"
`;
}

// An install that is not healthy, in plain words: no job names, paths or commit hashes.
export function failureWords(staging) {
  const failures = staging.failures || [];
  const runs = failures.map((f) => f.match(/^Your server runs (\S+), not /)).find(Boolean);
  if (runs) return `your server runs ${runs[1]} instead`;
  const cameUp = failures.map((f) => f.match(/the notebook says version (\S+), not /)).find(Boolean);
  if (cameUp) return `it came up as ${cameUp[1]}`;
  if (failures.some((f) => /add-ons on your server cannot reach the AI/.test(f))) return "the add-ons there cannot reach the AI since it was installed";
  if (failures.some((f) => /installer/.test(f))) return "its install did not finish well";
  if (failures.some((f) => /stage file/.test(f))) return "its stage file could not be written there";
  if (failures.some((f) => /instance/.test(f))) return "the notebook on your server came up as another instance";
  if (failures.some((f) => /scheduler last beat/.test(f))) return "the notebook's scheduler stopped running";
  if (failures.length) return "the notebook on your server was not healthy";
  return "see its record";
}

// ---------- the release records ----------

const recordIdentity = () => ({
  GIT_AUTHOR_NAME: "Godspeed release step",
  GIT_AUTHOR_EMAIL: cfg.gitEmail,
  GIT_COMMITTER_NAME: "Godspeed release step",
  GIT_COMMITTER_EMAIL: cfg.gitEmail,
});

function gitIn(root, args, { input, extraEnv } = {}) {
  const r = spawnSync("git", ["-C", root, ...args], { input, encoding: "utf8", env: { ...process.env, ...extraEnv }, maxBuffer: 64 << 20 });
  return { code: r.error ? -1 : r.status, out: r.stdout || "", err: (r.stderr || (r.error && r.error.message) || "").trim() };
}

function must(r, what) {
  if (r.code !== 0) R.refuse(`${what} failed in the records repository (${lastLine(r.err) || `exit ${r.code}`}); nothing was recorded.`);
  return r.out.trim();
}

export class Records {
  constructor(env = process.env) {
    this.root = env.RELEASE_RECORDS_ROOT || cfg.recordsRoot;
    this.fetched = false;
  }

  fetch() {
    const r = gitIn(this.root, ["fetch", "-q", "origin", "main"]);
    if (r.code !== 0) R.refuse(`the records repository's main could not be fetched into ${this.root} (${lastLine(r.err) || `exit ${r.code}`}), so its release records cannot be read.`);
    this.fetched = true;
  }

  read(rel) {
    if (!this.fetched) this.fetch();
    const r = gitIn(this.root, ["show", `origin/main:${rel}`]);
    return r.code === 0 ? r.out : null;
  }

  json(rel) {
    const text = this.read(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      R.refuse(`${rel} on the records repository's main is not JSON (${e.message}).`);
    }
  }

  releases() {
    if (!this.fetched) this.fetch();
    const r = gitIn(this.root, ["ls-tree", "--name-only", "origin/main", "releases/"]);
    if (r.code !== 0) return [];
    return r.out.split("\n").map((l) => l.trim().replace(/^releases\//, "")).filter(Boolean);
  }

  ticketFiles(id) {
    if (!this.fetched) this.fetch();
    const dir = `releases/${id}/tickets/`;
    const r = gitIn(this.root, ["ls-tree", "-r", "--name-only", "origin/main", dir]);
    if (r.code !== 0) R.refuse(`The tickets of ${id} could not be read from the records repository's main.`);
    return r.out.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(dir) && line.endsWith(".md"));
  }

  // The release folder that holds <version> of <ownerRepo>: its name carries the version (as in
  // godspeed-2.0.0-beta.8-faster-chat) and its plan.md says "repository: <ownerRepo>".
  findRelease(ownerRepo, version, named = null) {
    const names = this.releases();
    if (named) {
      if (!names.includes(named)) R.refuse(`There is no release ${named} on the records repository's main.`);
      return named;
    }
    const v = escapeRe(version);
    const carries = new RegExp(`(^|-)${v}(-|$)`);
    const says = new RegExp(`^repository:\\s*\`?${escapeRe(ownerRepo)}(?![\\w./-])`, "m");
    let hits = names.filter((n) => carries.test(n)).filter((n) => says.test(this.read(`releases/${n}/plan.md`) || ""));
    // A re-freeze (2.0.0-beta.26.1, then .2) belongs to the folder of the version it re-freezes, when no folder carries its own name.
    if (!hits.length && /^\d+\.\d+\.\d+-[A-Za-z]+\.\d+\.\d+$/.test(version)) {
      const baseCarries = new RegExp(`(^|-)${escapeRe(version.replace(/\.\d+$/, ""))}(-|$)`);
      hits = names.filter((n) => baseCarries.test(n)).filter((n) => says.test(this.read(`releases/${n}/plan.md`) || ""));
    }
    // A plan withdrawn before it was built (godspeed-2.0.0-beta.26-keeps-its-word) stays as a record
    // and never competes with the plan that replaced it under the same version.
    if (hits.length > 1) {
      const live = hits.filter((n) => !/^\s*status:\s*withdrawn\b/im.test(this.read(`releases/${n}/plan.md`) || ""));
      if (live.length) hits = live;
    }
    if (hits.length === 1) return hits[0];
    if (!hits.length) {
      R.refuse(`No release on the records repository's main names ${version} of ${ownerRepo} (a folder under releases/ with the version in its name whose plan.md says "repository: ${ownerRepo}"), so there is nowhere to keep its record; name one with --release <id>.`);
    }
    R.refuse(`${hits.length} releases on the records repository's main name ${version} of ${ownerRepo} (${hits.join(", ")}); name the one with --release <id>.`);
  }

  // One commit on top of origin/main holding these files, pushed to main; tried three times when
  // someone else pushed first. Returns the commit, or null when the files already say exactly this.
  write(files, message) {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.fetch();
      if (Object.entries(files).every(([rel, text]) => this.read(rel) === text)) return null;
      const base = must(gitIn(this.root, ["rev-parse", "origin/main"]), "Reading origin/main");
      const index = path.join(os.tmpdir(), `godspeed-records-${process.pid}-${Date.now()}-${attempt}.index`);
      try {
        const e = { GIT_INDEX_FILE: index };
        must(gitIn(this.root, ["read-tree", base], { extraEnv: e }), "Reading main's files");
        for (const [rel, text] of Object.entries(files)) {
          const blob = must(gitIn(this.root, ["hash-object", "-w", "--stdin"], { input: text }), `Writing ${rel}`);
          must(gitIn(this.root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], { extraEnv: e }), `Adding ${rel}`);
        }
        const tree = must(gitIn(this.root, ["write-tree"], { extraEnv: e }), "Writing the tree");
        const commit = must(gitIn(this.root, ["commit-tree", tree, "-p", base, "-m", message], { extraEnv: recordIdentity() }), "Writing the commit");
        const push = gitIn(this.root, ["push", "-q", "origin", `${commit}:refs/heads/main`]);
        if (push.code === 0) {
          gitIn(this.root, ["update-ref", "refs/remotes/origin/main", commit]);
          return commit;
        }
        last = push.err;
      } finally {
        fs.rmSync(index, { force: true });
      }
    }
    R.refuse(`the records repository's main refused the record three times (${lastLine(last)}); nothing was recorded.`);
  }
}

export const stagingPath = (release) => `releases/${release}/staging.json`;
export const goPath = (release) => `releases/${release}/go.json`;
export const recordText = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

// ---------- the gate, as the records say it ----------
//
// staging.json's status is "installed" once stage-server.mjs put the candidate on the server and it
// came up healthy as that version, and "failed" when it did not, or when a later check found the
// server no longer on it or no longer healthy; a failed record stays failed until the candidate is
// installed again. staging-check.mjs adds what the newest scenarios run on the candidate's tag said
// ("scenarios": its result, run and address, as of the last check).

// Whether the record says <version> was put on the server, came up healthy, and has not failed since.
// "running" and "passed" are what the code before 26 October 2026 evening wrote for such an install.
export function installedHealthy(staging, version) {
  const h = staging && staging.healthAfter;
  return !!staging && staging.version === version && ["installed", "running", "passed"].includes(staging.status) && !!staging.installedAt && !!h && h.ok === true && h.version === version;
}

// One scenarios run, looked at again while it is waited for: one anonymous request. Never throws:
// {completed} when it has finished, {limited, why} when GitHub refuses for its rate limit, and
// neither while it is still going or a look failed.
export async function scenarioRunState(env, ownerRepo, runId) {
  try {
    const r = await R.githubApi(readToken(env), env)("GET", `/repos/${ownerRepo}/actions/runs/${runId}`);
    if (r.status === 403 || r.status === 429) return { limited: true, why: `GitHub said ${r.status}` };
    return { completed: r.ok && !!r.json && r.json.status === "completed" };
  } catch {
    return { completed: false };
  }
}

// The scenarios, never throwing: a GitHub that cannot be read, for whatever reason, is an answer.
export async function scenariosOrUnread(env, ownerRepo, version, api = null) {
  try {
    return await scenarios(env, ownerRepo, version, api);
  } catch (e) {
    return { result: "unreadable", problem: e instanceof R.Refused ? e.message : `GitHub could not be read for the scenarios of ${version} (${e.message}).` };
  }
}

// What the record says of that install, for a sentence.
export function installWords(staging) {
  const h = staging.healthAfter;
  return `its record says ${staging.status}, installed ${staging.installedAt ? `at ${staging.installedAt}` : "at no recorded time"}, ${h ? `health after the install ok=${h.ok}, version ${h.version}` : "no health recorded after the install"}`;
}

// Whether the record says every scenario passed against the tag of <version>.
export const scenariosPassed = (staging, version) => !!staging && staging.version === version && !!staging.scenarios && staging.scenarios.result === "passed" && !!staging.scenarios.run;

// Whether a recorded go stands for <version>, read the way promote.mjs reads it: his go for exactly
// that version, newer than a healthy install of it that has not failed since.
export function goHolds(go, staging, version) {
  return !!go && go.version === version && installedHealthy(staging, version) && Date.parse(go.at) > Date.parse(staging.installedAt);
}

// ---------- the proving scenarios ----------

// The scenario runs are public data, read with no token by default. On a shared machine such as the
// server, where GitHub's 60 anonymous requests an hour are used up by other jobs (14 November 2026:
// a test failed on exactly that), auto-stage.mjs hands the reads a login through STAGING_READ_TOKEN.
// It is the machine's gh login, which could also write; these scripts only read with it.
export const readToken = (env) => (env && env.STAGING_READ_TOKEN) || null;

// The newest run of the product's scenarios workflow on the candidate's own tag that proved that
// tag, read from outside with no token: {result: "passed" | "failed" | "running" | "none", run, url,
// at}. The release step starts it on the tag itself, so that the run's commit is the tag's:
//   gh workflow run scenarios.yml --repo <owner/repo> --ref candidate/<version> -f stage=candidate/<version>
// A run started from another branch (main, as for 2.0.0-beta.7) does not count. The stage a run
// proved is its `stage` input, and since the product's scenarios.yml says `run-name: scenarios
// ${{ inputs.stage }}` (2.0.0-beta.8) GitHub shows it as the run's title: only a run titled
// "scenarios candidate/<version>" counts. One on the tag that was left at the workflow's default
// stage (beta) proved another stage; one from before the workflow named its stage (titled just
// "scenarios") cannot be told apart; neither counts, and "none" then says so ("ignored").
// api: a caller of its own (the stage step's asks GitHub again on 5xx); default the read token's.
export async function scenarios(env, ownerRepo, version, api = null) {
  const tag = `candidate/${version}`;
  api ||= R.githubApi(readToken(env), env);
  const tagCommit = await R.refSha(api, ownerRepo, `tags/${tag}`);
  if (!tagCommit) R.refuse(`${ownerRepo} has no tag ${tag}, so its scenarios cannot be looked up.`);
  const r = await api("GET", `/repos/${ownerRepo}/actions/workflows/${SCENARIOS_WORKFLOW}/runs?event=workflow_dispatch&branch=${encodeURIComponent(tag)}&per_page=30`);
  if (!r.ok || !r.json || !Array.isArray(r.json.workflow_runs)) {
    R.refuse(`GitHub said ${r.status} to listing the scenario runs of ${ownerRepo}, so whether ${tag} passed them cannot be told.`);
  }
  const title = `scenarios ${tag}`;
  const onTag = r.json.workflow_runs.filter((x) => x.head_branch === tag && x.head_sha === tagCommit);
  const runs = onTag.filter((x) => x.display_title === title).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!runs.length) {
    const ignored = ignoredRuns(tag, title, onTag);
    return { result: "none", tag, tagCommit, ...(ignored ? { ignored } : {}) };
  }
  const newest = runs[0];
  const found = { tag, tagCommit, run: newest.id, url: newest.html_url || null, at: newest.updated_at || newest.created_at };
  if (newest.status !== "completed") return { result: "running", ...found };
  if (newest.conclusion === "success") return { result: "passed", conclusion: newest.conclusion, ...found };
  // A failed run also records which of its jobs did not pass (failedJobs), so that a maintainer's
  // waiver (record-go.mjs --waive) can name only real failures. Left out when the jobs cannot be read.
  const failedJobs = await failedJobNames(api, ownerRepo, newest.id);
  return { result: "failed", conclusion: newest.conclusion, ...found, ...(failedJobs ? { failedJobs } : {}) };
}

// The names of the jobs of one run that did not pass (anything but success or skipped: a candidate run
// skips the jobs that do not hold up a release on purpose, so a skipped job is not a failure; a cancelled
// one is), or null when GitHub's list of the jobs cannot be read.
export async function failedJobNames(api, ownerRepo, runId) {
  try {
    const r = await api("GET", `/repos/${ownerRepo}/actions/runs/${runId}/jobs?per_page=100`);
    if (!r.ok || !r.json || !Array.isArray(r.json.jobs)) return null;
    if (r.json.total_count > r.json.jobs.length) return null;
    return r.json.jobs.filter((j) => j.conclusion !== "success" && j.conclusion !== "skipped").map((j) => j.name);
  } catch {
    return null;
  }
}

// The same names from the run's check runs (each job of a run is a check run of the same name in its check
// suite): a second way in when GitHub's list of the jobs does not answer (2026-11-24: 502 for twenty minutes
// on one run's jobs). Null when that cannot be read either.
export async function failedCheckNames(api, ownerRepo, runId) {
  try {
    const run = await api("GET", `/repos/${ownerRepo}/actions/runs/${runId}`);
    if (!run.ok || !run.json || !run.json.check_suite_id) return null;
    const r = await api("GET", `/repos/${ownerRepo}/check-suites/${run.json.check_suite_id}/check-runs?filter=latest&per_page=100`);
    if (!r.ok || !r.json || !Array.isArray(r.json.check_runs)) return null;
    if (r.json.total_count > r.json.check_runs.length) return null;
    return r.json.check_runs.filter((c) => c.status === "completed" && c.conclusion !== "success" && c.conclusion !== "skipped").map((c) => c.name);
  } catch {
    return null;
  }
}

// The maintainer's waiver (go.json "waived"): whether it covers every job the scenarios record says
// did not pass, so that run's failure is the maintainer's to take. False without a record of the
// failed jobs, and false when the run did not complete or nothing is waived.
export function scenariosWaived(staging, go, version) {
  const sc = staging && staging.version === version ? staging.scenarios : null;
  if (!sc || sc.result !== "failed" || !sc.run || !Array.isArray(sc.failedJobs) || !sc.failedJobs.length) return false;
  if (!go || !Array.isArray(go.waived) || !go.waived.length) return false;
  return sc.failedJobs.every((j) => go.waived.includes(j));
}

// THE STANDING WAIVER (Michael, 8 November 2026, 22:52 CET: "yes, please implement your rules"): a
// release is blocked only by the scenarios of its own new features. Its plan names them in a line
// "Blocking scenarios:" (names or distinctive parts of job names, comma separated, or as bullets
// right after the line). A failed job outside that list is named, with a one-line cause, in the
// result he sees and in go.json ("nonBlocking"), and does not block. Without such a list in the
// plan, nothing changes: every scenario must pass or be waived in his own words (record-go.mjs --waive).

// The plan's blocking scenarios, as a list of lower-cased names, or null when the plan names none.
export function blockingScenarios(plan) {
  const lines = String(plan || "").split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*(?:[-*]\s*)?(?:\*\*)?Blocking scenarios:(?:\*\*)?/i.test(l));
  if (at < 0) return null;
  const items = [];
  const clean = (x) => x.replace(/[`*]/g, "").replace(/\(.*?\)/g, "").replace(/[.\s]+$/g, "").trim().toLowerCase();
  const first = lines[at].replace(/^\s*(?:[-*]\s*)?(?:\*\*)?Blocking scenarios:(?:\*\*)?/i, "");
  for (const x of first.split(/[,;]/)) items.push(clean(x));
  for (let i = at + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[-*]\s+(.*)$/);
    if (!m) { if (lines[i].trim() === "" && items.some(Boolean)) break; if (lines[i].trim() === "") continue; break; }
    items.push(clean(m[1].replace(/\s+\(.*$/, "")));
    // A scenario's short name in the parenthesis ("(workouts-from-hevy, item 2)") blocks too, so a job
    // named after its slug cannot slip out of the list.
    const slug = m[1].match(/\(\s*`?([a-z0-9]+(?:-[a-z0-9]+)+)/i);
    if (slug) items.push(slug[1].toLowerCase());
  }
  const list = items.filter((x) => x.length >= 3);
  return list.length ? list : null;
}

// Whether the result he was shown names the job and, within the next 300 characters, its cause.
export function promptCarries(prompt, job, cause) {
  if (typeof prompt !== "string" || !job || !cause) return false;
  for (let at = prompt.indexOf(job); at >= 0; at = prompt.indexOf(job, at + 1)) {
    if (prompt.slice(at, at + job.length + 300).includes(cause)) return true;
  }
  return false;
}

// The workflow's own summary job fails whenever any other job fails; it is not a scenario, so it
// takes the verdict of the others (it blocks only while a blocking scenario does) and needs no cause.
export const AGGREGATE_JOBS = ["the verdict"];
export const isAggregateJob = (job) => AGGREGATE_JOBS.includes(String(job).trim().toLowerCase());

// The failed jobs the prompt Michael saw must name literally (record-go.mjs checks this, and
// auto-stage.mjs writes its message to satisfy it): every failed job, except that the summary job
// need not be named while a real scenario failed too. If it is the only failure, he must have seen it.
export function jobsPromptMustName(failedJobs) {
  const jobs = Array.isArray(failedJobs) ? failedJobs : [];
  const real = jobs.filter((j) => !isAggregateJob(j));
  return real.length ? real : jobs;
}

// Splits the failed jobs of the recorded run by the plan: {blocking, nonBlocking}, or null when this
// does not apply (the run did not complete as failed, the jobs are not recorded, or the plan names no
// blocking scenarios), so the old rule stays in force.
export function scenarioFailureSplit(staging, plan, version) {
  const sc = staging && staging.version === version ? staging.scenarios : null;
  if (!sc || sc.result !== "failed" || !sc.run || !Array.isArray(sc.failedJobs) || !sc.failedJobs.length) return null;
  const list = blockingScenarios(plan);
  if (!list) return null;
  const blocking = [];
  const nonBlocking = [];
  const aggregate = [];
  for (const job of sc.failedJobs) {
    if (AGGREGATE_JOBS.includes(job.trim().toLowerCase())) aggregate.push(job);
    else (list.some((b) => job.toLowerCase().includes(b)) ? blocking : nonBlocking).push(job);
  }
  return { blocking, nonBlocking, aggregate };
}

// Whether the scenarios clear the gate for the candidate by the plan: all passed, or every failure is
// outside the plan's blocking list.
export function scenariosClear(staging, plan, version) {
  if (scenariosPassed(staging, version)) return true;
  const split = scenarioFailureSplit(staging, plan, version);
  return !!split && split.blocking.length === 0 && split.nonBlocking.length > 0;
}

// What promote.mjs accepts of a failed run: every failed job is waived in his words (go.waived) or
// non-blocking by the plan with a cause recorded in the go (go.nonBlocking: [{job, cause}]) that is
// also in the prompt he was shown, so the result he decided on carried it. Returns
// {waived, nonBlocking} or null.
export function scenarioFailuresAccepted(staging, plan, go, version) {
  const sc = staging && staging.version === version ? staging.scenarios : null;
  if (!sc || sc.result !== "failed" || !sc.run || !Array.isArray(sc.failedJobs) || !sc.failedJobs.length || !go) return null;
  const waivedList = Array.isArray(go.waived) ? go.waived : [];
  const split = scenarioFailureSplit(staging, plan, version);
  const nonBlocking = [];
  const waived = [];
  const rest = [];
  for (const job of sc.failedJobs) {
    if (waivedList.includes(job)) { waived.push(job); continue; }
    if (split && split.aggregate.includes(job)) { rest.push(job); continue; }
    const named = Array.isArray(go.nonBlocking) ? go.nonBlocking.find((x) => x && x.job === job && typeof x.cause === "string" && x.cause.trim().length >= 3 && promptCarries(go.prompt, job, x.cause.trim())) : null;
    if (split && split.nonBlocking.includes(job) && named) { nonBlocking.push({ job, cause: named.cause.trim() }); continue; }
    return null;
  }
  // The summary job: accepted once every other failure is (waived or non-blocking), with no cause of its own.
  if (!waived.length && !nonBlocking.length) return null;
  const accepted = new Set([...waived, ...nonBlocking.map((x) => x.job)]);
  const unaccepted = sc.failedJobs.filter((j) => !accepted.has(j) && !rest.includes(j));
  if (unaccepted.length) return null;
  return { waived, nonBlocking };
}

// Why the runs on the tag that are not titled for it do not count, in plain words, or null.
function ignoredRuns(tag, title, onTag) {
  const runs = (n) => (n === 1 ? "One run" : `${n} runs`);
  const untitled = onTag.filter((x) => !x.display_title || x.display_title === "scenarios");
  const other = onTag.filter((x) => x.display_title && x.display_title !== "scenarios" && x.display_title !== title);
  const said = [];
  if (other.length) {
    const titles = [...new Set(other.map((x) => `"${x.display_title}"`))];
    const one = other.length === 1;
    said.push(`${runs(other.length)} on ${tag} ${one ? "is" : "are"} titled ${titles.join(" or ")}, not "${title}", so ${one ? "it" : "they"} proved another stage and ${one ? "does" : "do"} not count.`);
  }
  if (untitled.length) {
    const one = untitled.length === 1;
    said.push(`${runs(untitled.length)} on ${tag} ${one ? "has" : "have"} no stage in ${one ? "its" : "their"} title, from before the workflow named it, so which stage ${one ? "it" : "they"} proved cannot be told, and ${one ? "it does" : "they do"} not count.`);
  }
  return said.length ? said.join(" ") : null;
}

// Is this repository under the release process? The product of the main project always is; another one
// is when repos.json in the records checkout lists it (a throwaway rehearsal copy is not one of them).
export function underProcess(ownerRepo) {
  if (PRODUCT_REPO && String(ownerRepo).toLowerCase() === PRODUCT_REPO.toLowerCase()) return true;
  const file = path.join(cfg.recordsRoot, "repos.json");
  if (!fs.existsSync(file)) return false;
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return (list.repos || []).some((r) => String(r.repo).toLowerCase() === String(ownerRepo).toLowerCase());
  } catch (e) {
    R.refuse(`repos.json could not be read (${e.message}), so it cannot be told whether ${ownerRepo} is under the process.`);
  }
}

// ---------- what the public has, read from outside ----------

// The version on beta and the newest candidate tag newer than it that was not taken back, read the
// way a stranger reads them: with no token at all.
export async function publicState(env, ownerRepo, api = null) {
  const out = R.outside({ env, ownerRepo, isPrivate: false });
  const beta = await out.stageAt(R.PUBLIC_STAGE);
  api ||= R.githubApi(readToken(env), env);
  const r = await api("GET", `/repos/${ownerRepo}/git/matching-refs/tags/candidate/`);
  if (!r.ok || !Array.isArray(r.json)) R.refuse(`GitHub said ${r.status} to listing the candidate tags of ${ownerRepo}, so whether a candidate is open cannot be told.`);
  const versions = r.json.map((x) => String(x.ref).replace(/^refs\/tags\/candidate\//, "")).filter((v) => R.VERSION_PATTERN.test(v));
  const withdrawn = beta.stage.withdrawn || [];
  const open = versions.filter((v) => compareVersions(v, beta.stage.version) > 0 && !withdrawn.includes(v)).sort(compareVersions);
  return { publicVersion: beta.stage.version, candidate: open.length ? open[open.length - 1] : null, withdrawn, candidates: versions };
}

// The candidate's stage file at its tag, read from outside: its text exactly as the tag holds it.
export async function candidateStage(env, ownerRepo, version) {
  const api = R.githubApi(null, env);
  const tag = `candidate/${version}`;
  const sha = await R.refSha(api, ownerRepo, `tags/${tag}`);
  if (!sha) R.refuse(`${ownerRepo} has no tag ${tag}, so there is no frozen candidate of ${version}.`);
  const out = R.outside({ env, ownerRepo, isPrivate: false });
  const bytes = await out.fileAt(sha, R.STAGE_FILE);
  if (!bytes) R.refuse(`${out.where(sha, R.STAGE_FILE)} could not be read, so what ${tag} is made of is not known.`);
  const text = bytes.toString("utf8");
  const stage = R.parseStage(text, `at ${tag} of ${ownerRepo}`);
  if (stage.version !== version) R.refuse(`${R.STAGE_FILE} at ${tag} of ${ownerRepo} names version ${stage.version}, not ${version}.`);
  if (!R.COMMIT_PATTERN.test(String(stage.productCommit))) R.refuse(`${R.STAGE_FILE} at ${tag} of ${ownerRepo} names no product commit.`);
  return { tag, tagCommit: sha, stage, text };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
