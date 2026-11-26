import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-watcher.mjs   (runs the real watcher program with a stand-in for GitHub; no network)
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
const stub = path.join(dir, "stub.mjs");
fs.writeFileSync(stub, [
  "globalThis.fetch = async (url) => { const u = String(url);",
  "  const json = d => ({ ok: true, status: 200, json: async () => d });",
  "  if (u.includes(\"/issues?\") && process.env.STUB_HB_SEQ) { const seq = JSON.parse(process.env.STUB_HB_SEQ); const i = globalThis.__n = (globalThis.__n || 0) + 1; const v = seq[Math.min(i - 1, seq.length - 1)]; if (v === null) return { ok: false, status: 500, json: async () => ({}) }; return json([{ number: 1, state: \"open\", user: { login: \"MichaelZelbel\" }, body: \"<!-- factory-heartbeat -->\\nrecord\\n\\n```json\\n\" + JSON.stringify(v) + \"\\n```\" }]); }",
  "  if (u.includes(\"/contents/releases\") && !u.includes(\"?\")) return json([]);",
  "  if (u.includes(\"/issues?\")) return json(JSON.parse(process.env.STUB_ISSUES || \"[]\"));",
  "  return { ok: false, status: 404, json: async () => ({}) }; };",
].join(String.fromCharCode(10)));
const run = (heartbeat, issues = []) => spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, path.join(here, "../watcher/factory-watch.mjs"), "--dry-run"], { encoding: "utf8", env: { PATH: process.env.PATH, GH_TOKEN: "x", WATCH_REPO: "o/w", PRODUCT_RECORDS_REPO: "o/w", HEARTBEAT_TEST: heartbeat, GATE_WAIT_MS: "0", STUB_ISSUES: JSON.stringify(issues) } });
const runSeq = (seq, issues = []) => spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, path.join(here, "../watcher/factory-watch.mjs"), "--dry-run"], { encoding: "utf8", env: { PATH: process.env.PATH, GH_TOKEN: "x", WATCH_REPO: "o/w", PRODUCT_RECORDS_REPO: "o/w", GATE_WAIT_MS: "0", STUB_HB_SEQ: JSON.stringify(seq), STUB_ISSUES: JSON.stringify(issues) } });
const iso = ms => new Date(Date.now() - ms).toISOString();

test("the watcher runs: a fresh heartbeat says nothing; a stale, missing, invalid or future one is one alert", () => {
  assert.ok(!/ALERT/.test(run(JSON.stringify({ at: iso(60000), rung3: [] })).stdout));
  for (const hb of [JSON.stringify({ at: iso(40 * 60000), rung3: [] }), "", "{}", JSON.stringify({ at: new Date(Date.now() + 3600000).toISOString() })]) {
    const r = run(hb); assert.equal(r.status, 0, r.stderr); assert.equal((r.stdout.match(/ALERT heartbeat/g) || []).length, 1, JSON.stringify(hb));
  }
});

test("a rung 3 entry without a receipt for 30 minutes is an alert; with a receipt, or young, or an unreadable heartbeat, it is not", () => {
  const e = (receipts, ageMs) => JSON.stringify({ at: iso(60000), rung3: [{ id: "x", since: iso(ageMs), receipts }] });
  assert.match(run(e({}, 40 * 60000)).stdout, /ALERT rung3:x/);
  assert.ok(!/rung3:x/.test(run(e({ telegram: "1" }, 40 * 60000)).stdout)); assert.ok(!/rung3:x/.test(run(e({}, 5 * 60000)).stdout));
  assert.ok(!/ALERT rung3/.test(run("{}").stdout), "an invalid heartbeat evaluates no rung 3 entry");
});

test("an alert already open for a condition (authored by the bot, with its marker) is not repeated within 24 hours; a closed one is seen", () => {
  const stale = JSON.stringify({ at: iso(40 * 60000), rung3: [] });
  const issue = (state, ageMs) => [{ number: 5, state, created_at: iso(ageMs), user: { login: "github-actions[bot]" }, body: "@MichaelZelbel x <!-- watch:heartbeat -->" }];
  assert.ok(!/ALERT heartbeat/.test(run(stale, issue("open", 3600000)).stdout), "open and young: told already");
  assert.match(run(stale, issue("open", 30 * 3600000)).stdout, /ALERT heartbeat/, "open and a day old: told again");
  assert.ok(!/ALERT heartbeat/.test(run(stale, issue("closed", 30 * 3600000)).stdout), "closed: he saw it");
  assert.match(run(stale, [{ ...issue("closed", 30 * 3600000)[0], user: { login: "MichaelZelbel" } }]).stdout, /ALERT heartbeat/, "an issue not authored by the bot is nothing the watcher knows");
});

test("THE GATE in the watcher: a condition must hold in all 3 fresh reads; one fresh heartbeat in between, or an unreadable read, means no alarm", () => {
  const stale = { at: iso(40 * 60000), rung3: [] }, fresh = { at: iso(1000), rung3: [] };
  assert.match(runSeq([stale, stale, stale]).stdout, /ALERT heartbeat/, "stale in all three reads: the alarm");
  assert.ok(!/ALERT/.test(runSeq([stale, fresh, stale]).stdout), "fresh in the second read: it was only a moment");
  assert.ok(!/ALERT/.test(runSeq([stale, stale, fresh]).stdout), "fresh in the third read: nothing");
  const unreadable = runSeq([stale, null, stale]); assert.ok(!/ALERT/.test(unreadable.stdout), "a read that failed: look again, never alarm"); assert.match(unreadable.stdout, /heartbeat issue: github 500/, "the failed read is logged, nothing is sent");
  assert.ok(!/ALERT/.test(runSeq([null, null, null]).stdout), "a heartbeat that cannot be read at all: no alarm");
});

test("a cleared alert is no previous alert: a new occurrence alerts at once, even within the 24 hours", () => {
  const stale = JSON.stringify({ at: iso(40 * 60000), rung3: [] });
  const cleared = [{ number: 5, state: "closed", created_at: iso(3600000), user: { login: "github-actions[bot]" }, body: "@MichaelZelbel x <!-- watch:heartbeat --> <!-- watch:cleared -->" }];
  assert.match(run(stale, cleared).stdout, /ALERT heartbeat/, "the earlier occurrence was cleared: this one is new");
});
