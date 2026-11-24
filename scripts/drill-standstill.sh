#!/usr/bin/env bash
# The standstill drill: the condition for shipping a Forge release (the Forge 0.3.1 plan, "Proving"). It makes an approved
# release stand still the way Godspeed 2.0.0-beta.31 did on 2026-11-23 (every ticket done, the release step saying the same
# waiting sentence, a helper answering "in-progress" naming nothing), with the real driver and dead-man timers running, and
# then reads the driver's own journal. It passes only when it shows:
#   - an acting run launched by minute 20,
#   - the other AI launched by minute 40,
#   - a repair request in the dead-man's spool, read by the dead-man, by minute 60.
#
# ONLY ON A THROWAWAY MACHINE (Linux with systemd, as root). It shadows the codex and gh commands, writes the driver's
# settings and turns the driver's timers on. `install` runs only with FORGE_DRILL_THROWAWAY=yes in its environment and only on
# a machine with no Forge driver settings, state or projects of its own; it then marks the machine as the drill's
# (/var/lib/forge-drill/.throwaway), and every other command runs only on a machine so marked.
#
#   bash scripts/drill-standstill.sh install [archive]   install the Forge with its install line, from main's archive unless
#                                                         another is named (FORGE_VERSION=<tag> picks a release), on a stand-in
#                                                         Godspeed folder (the drill needs no Godspeed of its own)
#   bash scripts/drill-standstill.sh start               settings, stand-ins and records; the driver installed; the release made
#                                                         to stand still now (minute 0)
#   bash scripts/drill-standstill.sh check               read the journals: the minute of each step; exit 0 only when all three
#                                                         came by their minute
#   bash scripts/drill-standstill.sh run [archive]       install, then the FAST drill of both scenarios, one after the other (a few
#                                                         minutes): the default
#   bash scripts/drill-standstill.sh fast [scenario]     the fast drill on an installed Forge: the real driver and dead-man rounds run
#                                                         back to back with the clock moved forward (scripts/drill-standstill-fast.mjs
#                                                         imports their own code and gives them only the time), 14 rounds for the 65
#                                                         minutes, the acting runs real; no scenario named: both
#   bash scripts/drill-standstill.sh run --real-time [archive]
#                                                         install, start on the real timers, wait 65 minutes, check: ONLY for the single
#                                                         final check before a Forge release goes public
#   bash scripts/drill-standstill.sh reset               back to before start (to run it again); empties the notice queue too
#
# Two scenarios (FORGE_DRILL_SCENARIO, or the argument of fast/start): `beta31` (every ticket done, the stage step saying the same waiting
# sentence, an in-progress naming nothing: the Forge 0.3.1's) and `release-first` (the Forge 0.3.3's: Godspeed 2.0.0-beta.32 on
# 2026-11-24, seven of eight tickets closed, the last one workable and never picked, the factory busy elsewhere).
#
# Stand-ins, all in /var/lib/forge-drill: the AIs (codex shadowed in /usr/local/sbin, claude named in the settings) answer
# exactly what beta.31's helper answered; gh (shadowed in /usr/local/sbin and /usr/local/bin) shows two tickets closed by
# merged pull requests, nothing of the release's running and a run on main, and takes no writes; the stage step is a timer
# that writes beta.31's waiting sentence into the
# driver's look.txt every 15 minutes, as the stage step does. The driver, the dead-man, their units, timers, spool and
# journals are the real ones, installed by the install line.
set -eu

DRILL=/var/lib/forge-drill
SETTINGS=/etc/godspeed-forge
STATE=/var/lib/godspeed/forge/driver
SPOOL=/var/lib/forge-drill/spool # not the built-in default: the repair request must find the dead-man's own folder
RECORDS=$DRILL/records
WORKSPACE=$DRILL/godspeed-workspace
OWNER=drill-owner
REPO=drill-owner/drill-product
SCENARIO="${FORGE_DRILL_SCENARIO:-$(cat /var/lib/forge-drill/scenario 2>/dev/null || echo beta31)}"
case "$SCENARIO" in
  beta31) RELEASE=godspeed-2.0.0-beta.31-drill; RELEASE_VERSION=2.0.0-beta.31 ;;
  release-first) RELEASE=godspeed-2.0.0-beta.32-drill; RELEASE_VERSION=2.0.0-beta.32 ;;
  *) printf 'drill: unknown scenario %s (beta31 or release-first)
' "$SCENARIO" >&2; exit 2 ;;
esac
NOTICES=$WORKSPACE/.godspeed/notices.json
LOOK_FILE=$STATE/steps/stage/look.txt
MAIN_ARCHIVE=https://github.com/MichaelZelbel/godspeed-forge/archive/refs/heads/main.tar.gz
LIE="The factory driver is actively running the requested repair for the release's already-delivered first item."

say() { printf '%s\n' "$*"; }
stop() { printf 'drill: %s\n' "$*" >&2; exit 1; }

preconditions() {
  [ "$(id -u)" = "0" ] || stop "run this as root on a throwaway machine"
  [ -d /run/systemd/system ] || stop "this machine does not run systemd"
  [ -f "$DRILL/.throwaway" ] || stop "this machine is not marked as the drill's throwaway machine (bash $0 install, with FORGE_DRILL_THROWAWAY=yes, marks a fresh one); nothing was changed"
}
# Only a fresh machine becomes the drill's: no Forge driver settings, state or projects that the drill did not make.
claim_throwaway() {
  [ "$(id -u)" = "0" ] || stop "run this as root on a throwaway machine"
  [ -d /run/systemd/system ] || stop "this machine does not run systemd"
  [ -f "$DRILL/.throwaway" ] && return 0
  [ "${FORGE_DRILL_THROWAWAY:-}" = "yes" ] || stop "the drill harms a real server: run it only on a throwaway machine, with FORGE_DRILL_THROWAWAY=yes; nothing was changed"
  local found=""
  [ -e "$SETTINGS/driver.json" ] && found="$found $SETTINGS/driver.json"
  [ -n "$(ls -A "$SETTINGS/projects" 2>/dev/null)" ] && found="$found $SETTINGS/projects"
  [ -e "$STATE" ] && found="$found $STATE"
  [ -e /var/lib/godspeed/forge/deadman ] && found="$found /var/lib/godspeed/forge/deadman"
  systemctl list-unit-files 'factory-driver.timer' 'archonfactory-*' --no-legend 2>/dev/null | grep -q . && found="$found (the factory's units)"
  [ -n "$found" ] && stop "this machine already has a Forge driver or factory:$found. The drill runs only on a fresh throwaway machine; nothing was changed"
  mkdir -p "$DRILL" && date -u +%FT%TZ >"$DRILL/.throwaway"
}

do_install() {
  claim_throwaway
  local archive="${1:-$MAIN_ARCHIVE}"
  command -v node >/dev/null 2>&1 || stop "the install line needs a Node 22 here first (the one Godspeed brings on a real server)"
  mkdir -p "$WORKSPACE/.godspeed"
  say "Installing the Forge with its install line from $archive ..."
  if [ -n "${FORGE_VERSION:-}" ]; then
    curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | GODSPEED_WORKSPACE="$WORKSPACE" GODSPEED_VERSION=2.0.0-beta.31 FORGE_VERSION="$FORGE_VERSION" bash
  else
    curl -fsSL https://github.com/MichaelZelbel/godspeed-forge/raw/main/install.sh | GODSPEED_WORKSPACE="$WORKSPACE" GODSPEED_VERSION=2.0.0-beta.31 FORGE_ARCHIVE_URL="$archive" bash
  fi
}

# The Forge's own command, as the install line put it
forge() {
  local f
  for f in "$(command -v godspeed-forge 2>/dev/null || true)" /usr/local/bin/godspeed-forge /usr/local/lib/godspeed/forge/addon/bin/godspeed-forge.mjs; do
    [ -n "$f" ] && [ -e "$f" ] || continue
    case "$f" in *.mjs) node "$f" "$@" ;; *) "$f" "$@" ;; esac
    return
  done
  stop "the Forge is not installed here (run: bash $0 install)"
}

write_standins() {
  mkdir -p "$DRILL/bin" "$SPOOL" "$DRILL/tools" "$DRILL/holdouts" "$DRILL/brain" "$WORKSPACE/.godspeed"
  # the AI: beta.31's helper, word for word, for every run (rung 1, rung 2 and the dead-man's repair runs)
  cat >"$DRILL/bin/answer" <<EOF
#!/usr/bin/env bash
printf '%s\n\nRESULT: in-progress\n' "$LIE"
EOF
  cat >"$DRILL/bin/codex" <<'EOF'
#!/usr/bin/env bash
# the drill's stand-in for codex: the answer goes to -o <file> as codex does, and to stdout
out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done
cat >/dev/null
/var/lib/forge-drill/bin/answer | tee ${out:+"$out"}
EOF
  cat >"$DRILL/bin/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
/var/lib/forge-drill/bin/answer
EOF
  chmod 755 "$DRILL/bin/answer" "$DRILL/bin/codex" "$DRILL/bin/claude"
  mkdir -p /usr/local/sbin
  [ -e /usr/local/sbin/codex ] && ! grep -q forge-drill /usr/local/sbin/codex && stop "/usr/local/sbin/codex exists and is not the drill's"
  ln -sf "$DRILL/bin/codex" /usr/local/sbin/codex # first on the acting runs' PATH
  # GitHub: a stand-in gh, first on every PATH the driver uses: two tickets closed by merged pull requests, nothing of the
  # release's running, and one run on main in progress (activity near the release that is not the release's)
  cat >"$DRILL/bin/gh-standin.mjs" <<'EOF'
import fs from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "auth") process.exit(0); // "gh auth status": signed in
const refuse = (why, what) => { fs.appendFileSync("/var/lib/forge-drill/gh-unanswered.log", `${new Date().toISOString()} ${what}\n`); process.stderr.write(`${why}\n`); process.exit(1); };
if (argv[0] !== "api") refuse("the drill's stand-in GitHub answers only reads", `gh ${argv.join(" ")}`);
const args = argv.slice(1).filter(x => x !== "--paginate");
if (args.includes("-X") || args.includes("--method") || args.includes("--input")) refuse("the drill's stand-in GitHub takes no writes", `WRITE ${args.join(" ")}`);
const a = args.join(" "), REPO = "drill-owner/drill-product", now = Date.now(), iso = ms => new Date(ms).toISOString();
const sha = n => String(n).padStart(40, "a");
const say = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
let m;
if ((m = new RegExp(`repos/${REPO}/issues/(\\d+)/comments`).exec(a))) say([]);
const scenario = (() => { try { return fs.readFileSync("/var/lib/forge-drill/scenario", "utf8").trim(); } catch { return "beta31"; } })();
// release-first: the last ticket (#616) is open and workable, the others closed by merged pull requests
if ((m = new RegExp(`repos/${REPO}/issues/(\\d+)$`).exec(a))) say(scenario === "release-first" && m[1] === "616" ? { number: 616, state: "open", labels: [{ name: "bug" }, { name: "priority" }], created_at: iso(now - 30 * 3600e3) } : { number: Number(m[1]), state: "closed", state_reason: "completed", closed_at: iso(now - 26 * 3600e3), labels: [] });
if (args[0] === "graphql" && (m = /issue\(number: (\d+)\)/.exec(a))) say({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: Number(m[1]) + 100 }] }, timelineItems: { nodes: [] }, refs: { nodes: [] }, comments: { nodes: [] } } } } });
if ((m = new RegExp(`repos/${REPO}/pulls/(\\d+)$`).exec(a))) say({ number: Number(m[1]), state: "closed", merged_at: iso(now - 27 * 3600e3), merge_commit_sha: sha(m[1]), base: { ref: "main" }, head: { sha: sha(`${m[1]}0`) }, labels: [], created_at: iso(now - 30 * 3600e3) });
if (/commits\/main$/.test(a)) say({ sha: sha(1) });
if (/check-runs/.test(a)) say({ check_runs: [{ name: "required", status: "completed", conclusion: "success", started_at: iso(now - 28 * 3600e3), completed_at: iso(now - 27.5 * 3600e3) }] });
if ((m = /commits\/(\w+)$/.exec(a))) say({ sha: m[1], commit: { committer: { date: iso(now - 28 * 3600e3) } } });
if (/issues\?state=open&labels=needs-owner/.test(a)) say([]);
if (/^search\/issues/.test(a)) say({ items: [] });
if (/actions\/runs\?status=in_progress/.test(a)) say({ workflow_runs: [{ head_branch: "main", head_sha: sha(1), run_started_at: iso(now - 2 * 60e3), name: "required" }] });
if (/actions\/(workflows\/[^/]+\/)?runs/.test(a)) say({ workflow_runs: [] });
refuse(`the drill's stand-in GitHub has no answer for: ${a}`, a);
EOF
  printf '#!/usr/bin/env bash\nexec node %s/bin/gh-standin.mjs "$@"\n' "$DRILL" >"$DRILL/bin/gh"
  chmod 755 "$DRILL/bin/gh"
  for d in /usr/local/sbin /usr/local/bin; do
    [ -e "$d/gh" ] && ! [ "$(readlink "$d/gh" 2>/dev/null)" = "$DRILL/bin/gh" ] && stop "$d/gh exists and is not the drill's"
    ln -sf "$DRILL/bin/gh" "$d/gh"
  done
  # the stage step: beta.31's waiting sentence, written into the driver's look.txt every 15 minutes
  cat >"$DRILL/bin/stage-look" <<EOF
#!/usr/bin/env bash
mkdir -p "$(dirname "$LOOK_FILE")"
if [ "\$(cat $DRILL/scenario 2>/dev/null)" = "release-first" ]; then
  printf '%s\n' "Release $RELEASE ($RELEASE_VERSION): approved, newer than the public version, and not on the server yet." "Not complete yet: waiting on #616." "Result: waiting." >"$LOOK_FILE.tmp"
else
  printf '%s\n' "Release $RELEASE ($RELEASE_VERSION): approved, newer than the public version, and not on the server yet." "Waiting for the factory driver to move item 1 to the next release under the plan's rule." "Result: waiting." >"$LOOK_FILE.tmp"
fi
mv "$LOOK_FILE.tmp" "$LOOK_FILE"
EOF
  chmod 755 "$DRILL/bin/stage-look"
  cat >/etc/systemd/system/forge-drill-stage.service <<EOF
[Unit]
Description=The standstill drill's stand-in for the stage step (beta.31's waiting sentence)
[Service]
Type=oneshot
ExecStart=$DRILL/bin/stage-look
EOF
  cat >/etc/systemd/system/forge-drill-stage.timer <<'EOF'
[Unit]
Description=The standstill drill's stand-in for the stage step, every 15 minutes after minute 0
[Timer]
OnActiveSec=15min
OnUnitActiveSec=15min
EOF
}

write_records() {
  # the records belong to one scenario: another scenario makes them again
  if [ -d "$RECORDS/.git" ] && [ "$(cat "$DRILL/records-scenario" 2>/dev/null)" = "$SCENARIO" ]; then return; fi
  rm -rf "$RECORDS"
  mkdir -p "$RECORDS/releases/$RELEASE/tickets"
  if [ "$SCENARIO" = "release-first" ]; then
    cat >"$RECORDS/releases/$RELEASE/plan.md" <<EOF
---
release: $RELEASE
repository: $REPO
---
Status: approved by the drill owner

# Godspeed $RELEASE_VERSION: the release-first drill

Issues: item 1 #609, 2 #610, 3 #611, 4 #612, 5 #613, 6 #614, 7 #615, 8 #616

The plan's rule: an item that reaches a dead end leaves the release, the rest ships.
EOF
    for n in 1 2 3 4 5 6 7 8; do printf '# ticket %s\n\nSize: medium.\n' "$n" >"$RECORDS/releases/$RELEASE/tickets/0$n-ticket-$n.md"; done
  else
    cat >"$RECORDS/releases/$RELEASE/plan.md" <<EOF
---
release: $RELEASE
repository: $REPO
---
Status: approved by the drill owner

# Godspeed 2.0.0-beta.31: the standstill drill

Issues: item 1 #783, 2 #784

The plan's rule: an item that reaches a dead end leaves the release, the rest ships.
EOF
    printf '# already there\n\nSize: medium.\n' >"$RECORDS/releases/$RELEASE/tickets/01-already-there.md"
    printf '# the second\n\nSize: medium.\n' >"$RECORDS/releases/$RELEASE/tickets/02-the-second.md"
  fi
  echo "$SCENARIO" >"$DRILL/records-scenario"
  git -C "$RECORDS" init -q -b main
  git -C "$RECORDS" -c user.name=drill -c user.email=drill@localhost add -A
  git -C "$RECORDS" -c user.name=drill -c user.email=drill@localhost commit -q -m "the drill's approved release"
}

write_settings() {
  id factory >/dev/null 2>&1 || useradd -m -s /bin/bash factory
  loginctl enable-linger factory >/dev/null 2>&1 || true
  local uid; uid="$(id -u factory)"
  mkdir -p "$SETTINGS/projects"
  cat >"$SETTINGS/driver.json" <<EOF
{
  "_drill": "forge-drill",
  "owner": { "github_login": "$OWNER", "name": "the drill owner" },
  "server": { "factory_user": "factory", "factory_uid": $uid, "state_dir": "$STATE", "spool_dir": "$SPOOL" },
  "ai": { "act_brain_dir": "$DRILL/brain", "bins": { "claude": "$DRILL/bin/claude" } },
  "budget": { "act_runs_per_day": 8, "reserved": 4 },
  "notices": { "watch_repo": "", "godspeed_notices_file": "$WORKSPACE/.godspeed/notices.json" },
  "steps": { "stage": { "enabled": false }, "plan": { "enabled": false }, "questions": { "enabled": false }, "test-machine": { "enabled": false }, "trust": { "enabled": false }, "keep-main-green": { "enabled": false }, "owner-releases": { "enabled": false }, "owner-questions": { "enabled": false } },
  "env": { "FD_MAX_HELPERS": "0" }
}
EOF
  cat >"$SETTINGS/projects/drill-owner--drill-product.json" <<EOF
{
  "repository": "$REPO",
  "project": "drill-product",
  "checkout": "/home/factory/drill-product",
  "apps": { "builder": "drill-builder", "release": "drill-release" },
  "releases": { "records_repo": "drill-owner/drill-records", "records_checkout": "$RECORDS", "plan_pattern": "^godspeed-\\\\d", "health_url": "http://127.0.0.1:9/health", "version_file": "$WORKSPACE/VERSION", "tools_dir": "$DRILL/tools", "holdouts_dir": "$DRILL/holdouts" }
}
EOF
}

do_start() {
  preconditions
  mkdir -p "$DRILL" && printf '%s
' "$SCENARIO" >"$DRILL/scenario"
  write_standins
  write_records
  write_settings
  say "Installing the driver with the drill's settings ..."
  forge driver install --settings-dir "$SETTINGS"
  systemctl daemon-reload
  if [ "${DRILL_FAST:-}" = "yes" ]; then
    # the fast drill moves the clock itself: no timer of the machine runs, so nothing runs a round in between
    systemctl disable --now factory-driver.timer factory-deadman.timer forge-drill-stage.timer >/dev/null 2>&1 || true
    : >"$NOTICES.fresh"; rm -f "$NOTICES.fresh"
    date -u +%s%3N >"$DRILL/started-at"
    say "The fast drill (scenario $SCENARIO) starts from $(date -u -d "@$(( $(cat "$DRILL/started-at") / 1000 ))" +%FT%TZ) (minute 0)."
    return 0
  fi
  # the drill starts on a driver that has done a round, as on a server where it has run for a while (its clock counts a new
  # state from the last round that saw the old one)
  say "Running the driver's first round ..."
  systemctl start factory-driver.service || stop "the driver's first round failed: journalctl -u factory-driver.service"
  # minute 0 right after a round on the driver's own timer: the worst moment for a change, as the next round is the furthest away
  say "Waiting for the driver's next round on its timer ..."
  local before; before="$(stat -c %Y "$STATE/heartbeat" 2>/dev/null || echo 0)"
  until [ "$(stat -c %Y "$STATE/heartbeat" 2>/dev/null || echo 0)" -gt "$before" ]; do sleep 2; done
  # minute 0: the release step starts saying beta.31's waiting sentence, and nothing about the release changes after it; the
  # stand-in stage step repeats it every 15 minutes from now on (never before minute 0, so the drill measures from the change)
  date -u +%s%3N >"$DRILL/started-at" # in milliseconds
  "$DRILL/bin/stage-look"
  systemctl start forge-drill-stage.timer
  say "The release $RELEASE stands still from $(date -u -d "@$(( $(cat "$DRILL/started-at") / 1000 ))" +%FT%TZ) (minute 0). Check with: bash $0 check (after minute 60)."
}

do_check() {
  [ -f "$DRILL/started-at" ] || stop "the drill was not started here (bash $0 start)"
  local t0; t0="$(cat "$DRILL/started-at")"
  if [ -f "$DRILL/deadman-fast.json" ]; then cp "$DRILL/deadman-fast.json" "$DRILL/deadman-journal.json"; else
    journalctl -u factory-deadman.service --since "@$((t0 / 1000))" -o json --no-pager >"$DRILL/deadman-journal.json" 2>/dev/null || true
  fi
  cat >"$DRILL/bin/check.mjs" <<'CHECK'
    import fs from "node:fs";
    const { DRILL, STATE, SPOOL, RELEASE } = process.env, t0 = Number(process.env.T0); // milliseconds
    const minute = at => ((typeof at === "number" ? at : Date.parse(at)) - t0) / 60000; // exact: a step at 20 minutes and one millisecond is late
    const shown = m => m.toFixed(2);
    const lines = fs.readFileSync(`${STATE}/decisions.jsonl`, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => Date.parse(e.at) >= t0 - 5 * 60000);
    const mine = lines.filter(e => e.entry === `standstill:${RELEASE}` || e.release === RELEASE || (e.entries || []).includes(`standstill:${RELEASE}`));
    const launch = r => mine.find(e => e.kind === "acting run launched" && e.rung === r);
    const repair = mine.find(e => e.kind === "repair requested");
    // a notice counts only when it reached the owner: Godspeed's notice queue took it (the stand-in workspace's notices.json)
    const toldAll = mine.filter(e => e.kind === "told Michael" && (e.queue === true || Object.keys(e.receipts || {}).length > 0)), told = toldAll[0];
    const queued = (() => { try { return JSON.parse(fs.readFileSync(`${DRILL}/godspeed-workspace/.godspeed/notices.json`, "utf8")).notices.filter(n => /has not moved for about an hour/.test(n.text)).filter(n => { const w = Date.parse(n.at || n.createdAt || n.created_at || ""); return !Number.isFinite(w) || w >= t0; }); } catch { return []; } })(); // only what was written after minute 0
    if (queued.length) console.log(`the owner's notice, as Godspeed's queue holds it: ${queued[0].text}`);
    const spool = (() => { try { return fs.readdirSync(SPOOL).filter(n => /^(repair|handled)-.*\.json$/.test(n)); } catch { return []; } })();
    // the real timers' journal (one JSON line each), or the fast drill's own log (an array: the minute each line was said at)
    const raw = fs.readFileSync(`${DRILL}/deadman-journal.json`, "utf8");
    const fast = raw.trim().startsWith("[") ? JSON.parse(raw).map(j => ({ at: Date.parse(j.at), text: String(j.text || "") })) : [];
    const dm = (fast.length || raw.trim().startsWith("[") ? "" : raw).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .map(j => ({ at: Number(j.__REALTIME_TIMESTAMP) / 1000, text: String(j.MESSAGE || "") })).concat(fast).filter(j => /asked for a repair/.test(j.text));
    const read = repair ? dm.find(j => j.at >= Date.parse(repair.at)) : null;
    console.log(`minute 0 = ${new Date(t0).toISOString()} (the release step began to say beta.31's waiting sentence)`);
    console.log("the driver's own journal (decisions.jsonl), the release clock's lines:");
    for (const e of mine) console.log(`  minute ${shown(minute(e.at))}: ${JSON.stringify(e)}`);
    console.log("the dead-man's journal (journalctl -u factory-deadman), its reading of the spool:");
    for (const j of dm.slice(0, 3)) console.log(`  minute ${shown(minute(j.at))}: ${j.text}`);
    console.log(`the dead-man's spool ${SPOOL}: ${spool.join(", ") || "empty"}`);
    const checks = [
      ["an acting run launched by minute 20", launch(1) && minute(launch(1).at) <= 20, launch(1) && `minute ${shown(minute(launch(1).at))}, ${launch(1).provider}`],
      ["the other AI launched by minute 40", launch(2) && minute(launch(2).at) <= 40 && launch(2).provider !== launch(1)?.provider, launch(2) && `minute ${shown(minute(launch(2).at))}, ${launch(2).provider}`],
      ["a repair request in the dead-man spool by minute 60", repair && minute(repair.at) <= 60 && spool.length > 0, repair && `minute ${shown(minute(repair.at))}, ${repair.file}`],
      ["read by the dead-man by minute 60", read && minute(read.at) <= 60, read && `minute ${shown(minute(read.at))}`],
      ["one notice to the owner, by minute 60, in Godspeed's queue", toldAll.length === 1 && minute(told.at) <= 60 && queued.length === 1, told && `minute ${shown(minute(told.at))}, ${toldAll.length} in all, ${queued.length} in the queue`],
    ];
    let ok = true;
    for (const [what, pass, how] of checks) { console.log(`${pass ? "PASS" : "FAIL"}: ${what}${how ? ` (${how})` : ""}`); if (!pass) ok = false; }
    console.log(ok ? "THE DRILL PASSED" : "THE DRILL FAILED");
    process.exit(ok ? 0 : 1);
  
CHECK
  DRILL="$DRILL" STATE="$STATE" SPOOL="$SPOOL" RELEASE="$RELEASE" T0="$t0" node "$DRILL/bin/check.mjs"
}

# Back to before `start` (the Forge stays installed): the driver's timers off, its state, the dead-man's and the drill's gone.
do_reset() {
  preconditions
  systemctl disable --now factory-driver.timer factory-deadman.timer >/dev/null 2>&1 || true
  systemctl stop forge-drill-stage.timer >/dev/null 2>&1 || true
  rm -rf "$STATE" /var/lib/godspeed/forge/deadman "$SPOOL" "$DRILL/started-at" "$DRILL/deadman-journal.json" "$DRILL/deadman-fast.json"
  # the stand-in Godspeed's notice queue: a notice left by an earlier run must never count in the next one
  rm -f "$NOTICES"
  rm -f "$SETTINGS/driver.json" "$SETTINGS/driver.env" "$SETTINGS/projects/drill-owner--drill-product.json" /usr/local/sbin/gh /usr/local/bin/gh
}

# One fast drill: reset, start (the helper moves the clock; no timer of the machine runs), the rounds, check.
fast_one() {
  SCENARIO="$1"
  case "$SCENARIO" in
    beta31) RELEASE=godspeed-2.0.0-beta.31-drill; RELEASE_VERSION=2.0.0-beta.31 ;;
    release-first) RELEASE=godspeed-2.0.0-beta.32-drill; RELEASE_VERSION=2.0.0-beta.32 ;;
    *) stop "unknown scenario $SCENARIO (beta31 or release-first)" ;;
  esac
  say "=== The fast drill, scenario $SCENARIO ==="
  do_reset
  DRILL_FAST=yes do_start
  node "$(dirname "$0")/drill-standstill-fast.mjs" "$(cat "$DRILL/started-at")" 65 5
  do_check
}
do_fast() {
  preconditions
  local failed=0 sc
  for sc in ${1:-beta31 release-first}; do fast_one "$sc" || failed=1; done
  if [ "$failed" = "0" ]; then say "ALL FAST DRILLS PASSED"; else say "A FAST DRILL FAILED"; return 1; fi
}

case "${1:-}" in
  install) shift; do_install "$@" ;;
  start) shift; [ -z "${1:-}" ] || SCENARIO="$1"; do_start ;;
  check) do_check ;;
  reset) do_reset ;;
  fast) shift; do_fast "$@" ;;
  run)
    shift
    if [ "${1:-}" = "--real-time" ]; then
      shift; do_install "$@"; do_start; say "Waiting 65 minutes (the real timers; only for the final check before a release goes public) ..."; sleep 3900; do_check
    else
      do_install "$@"; do_fast
    fi ;;
  *) say "usage: bash $0 install [archive] | fast [scenario] | run [archive] | run --real-time [archive] | start [scenario] | check | reset"; exit 2 ;;
esac
