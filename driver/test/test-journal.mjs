// node --test scripts/factory-driver/test-journal.mjs   (offline)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, readJournal, headMirrorOk, recover, view, roundEvents, prEvents, prSeenMap, coverage, containment, containmentCommits, monotonicNow, GENESIS } from "../journal.mjs";
import { clockCheck, wentBackwards, verifyInstalled, sendTelegram, openIssue, findNotifyIssue, refOf, deliver, pollSeen, seenKey, telegramCreds } from "../facts.mjs";

const NOW = Date.parse("2026-11-21T22:00:00Z"), H = 3600000;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jr-")), "journal.jsonl");
const REL = "godspeed-1.0.0-r1";
const world = (over = {}) => ({ releases: [{ id: REL, tickets: [{ item: 1, issue: 11 }, { item: 2, issue: 12 }] }], items: { 11: { state: "open", prs: [{ number: 5, state: "open", requiredState: "none" }] }, 12: { state: "open", prs: [] } }, staging: {}, unreadable: [], ...over });

test("the journal is append-only and hash-chained: an edited, removed, truncated or half-written line makes it unreadable, and one narrow command recovers it", () => {
  const f = tmp();
  appendEvents(f, [{ t: "approved", release: REL, at: new Date(NOW).toISOString(), tickets: [] }]);
  appendEvents(f, [{ t: "slot", release: REL, slot: "r:resolved", at: new Date(NOW).toISOString() }, { t: "round", at: new Date(NOW).toISOString() }]);
  const r = readJournal(f); assert.ok(r.ok && r.events.length === 3 && r.head !== GENESIS);
  const text = fs.readFileSync(f, "utf8"), lines = text.trim().split("\n");
  fs.writeFileSync(f, lines.map((l, i) => (i === 1 ? l.replace("r:resolved", "r:installed") : l)).join("\n") + "\n"); assert.equal(readJournal(f).ok, false, "an edited line");
  fs.writeFileSync(f, [lines[0], lines[2]].join("\n") + "\n"); assert.equal(readJournal(f).ok, false, "a removed line");
  fs.writeFileSync(f, text + '{"t":"sl'); assert.equal(readJournal(f).ok, false, "a half-written line");
  fs.writeFileSync(f, lines[0] + "\n" + lines[1] + "\n" + lines[2].slice(0, 20) + "\n");
  const rec = recover(f, new Date(NOW));
  assert.equal(rec.kept, 2); assert.equal(rec.cut, 1);
  const after = readJournal(f); assert.ok(after.ok); assert.equal(after.events.at(-1).t, "recovered");
  assert.ok(fs.readdirSync(path.dirname(f)).some(n => n.includes("before-recovery")), "the damaged file is kept");
  assert.equal(readJournal(path.join(path.dirname(f), "none.jsonl")).ok, true, "a missing journal is an empty one (the first round)");
});

test("the journal's head is mirrored on GitHub: a head that is not a line of this journal means it was replaced or rolled back", () => {
  const f = tmp(); appendEvents(f, [{ t: "round", at: "2026-11-21T00:00:00Z" }]); const h1 = readJournal(f).head;
  appendEvents(f, [{ t: "round", at: "2026-11-21T00:05:00Z" }]);
  assert.ok(headMirrorOk(f, h1), "behind is fine"); assert.ok(headMirrorOk(f, ""), "nothing mirrored yet");
  assert.equal(headMirrorOk(f, "f".repeat(32)), false, "a head this journal never had");
});

test("an approval can vanish and a read can be incomplete: both are found by identity, explained only by journaled milestones", () => {
  const w = world(); const ev = roundEvents(view([]), w, NOW - 5 * H, {}); const v = view([...ev, ...prEvents(view(ev), w, NOW - 5 * H)]);
  assert.deepEqual(coverage(v, w, prSeenMap(v)), [], "nothing missing");
  // the release disappears from the read (bad edit, stale checkout)
  assert.match(coverage(v, world({ releases: [] }), {})[0].why, /in the journal but this round's read did not find it/);
  // a sealed ticket's issue is unreadable
  const w2 = world(); delete w2.items[12];
  assert.ok(coverage(v, w2, {}).some(c => /ticket 2 .* could not be read/.test(c.why)));
  // a pull request seen before is gone and nothing journaled explains it, regardless of how many remain (no counting)
  const w3 = world(); w3.items[11] = { state: "open", prs: [{ number: 6, state: "open" }, { number: 7, state: "open" }] };
  const gone = coverage(v, w3, prSeenMap(v)); assert.ok(gone.some(c => /pull request 5 of ticket 1 was seen before and is gone/.test(c.why)));
  // the same disappearance IS explained when the journal holds that ticket's merged slot, and the previous round's state is never consulted
  const v2 = view([...ev, ...prEvents(view(ev), w, NOW), { t: "slot", release: REL, slot: "t:1:merged", at: new Date(NOW).toISOString() }]);
  assert.deepEqual(coverage(v2, w3, prSeenMap(v2)), []);
});

test("a newer install discards an older release only after the containment check: the issues AND the merge commits (merge-base --is-ancestor)", () => {
  assert.ok(containment({ unfinished: [11], cut: [] }, { issues: [11, 12] }).contained);
  assert.deepEqual(containment({ unfinished: [11, 13], cut: [] }, { issues: [11] }).missing, [13]);
  assert.ok(containment({ unfinished: [13], cut: [13] }, { issues: [] }).contained, "cut under D-427 counts");
  const ancestors = new Set(["aaa"]);
  const c = containmentCommits(["aaa", "bbb"], "head", (sha, to) => ancestors.has(sha));
  assert.equal(c.contained, false); assert.deepEqual(c.missing, ["bbb"]);
});

test("intervals are monotonic: a wall-clock jump is a stall and the round counts from the last round plus the real interval", () => {
  const last = { at: NOW, mono: 1000, boot: "b1" };
  assert.deepEqual(monotonicNow(NOW + 5 * 60000, last, { uptime: 1300, boot: "b1" }), { now: NOW + 5 * 60000, jumped: false });
  const j = monotonicNow(NOW + 90 * 24 * H, last, { uptime: 1300, boot: "b1" }); assert.ok(j.jumped); assert.equal(j.now, NOW + 300000, "a jump forward cannot fire every deadline");
  const back = monotonicNow(NOW - 3 * H, last, { uptime: 1300, boot: "b1" }); assert.ok(back.jumped); assert.equal(back.now, NOW + 300000);
  assert.equal(monotonicNow(NOW + 99 * H, last, { uptime: 5, boot: "b2" }).jumped, false, "a reboot starts over: the wall clock anchors");
  assert.ok(wentBackwards(NOW - 5 * 60000, NOW)); assert.ok(!wentBackwards(NOW + 1, NOW));
});

test("GitHub's Date header is only an anchor: a difference over 5 minutes is a stall, an unreachable GitHub is not ours", () => {
  const run = d => () => ({ stdout: `HTTP/2 200\r\nDate: ${d}\r\n\r\n{}` });
  assert.equal(clockCheck(Date.parse("2026-11-21T22:01:00Z"), run("Sat, 21 Nov 2026 22:00:00 GMT")).ok, true);
  const bad = clockCheck(Date.parse("2026-11-21T22:10:00Z"), run("Sat, 21 Nov 2026 22:00:00 GMT")); assert.equal(bad.ok, false); assert.equal(bad.ghNow, Date.parse("2026-11-21T22:00:00Z"));
  assert.equal(clockCheck(NOW, () => ({ stdout: "" })).ok, true);
});

test("installed is a fresh fact: the running Godspeed answers with the release's version AND the running install's commit is the frozen candidate's", () => {
  const staging = { productCommit: "abc123", version: "2.0.0-beta.29" }, rel = { version: "2.0.0-beta.29" };
  const ok = verifyInstalled(rel, staging, { health: () => ({ ok: true, version: "2.0.0-beta.29" }), commit: () => "abc123\n" }); assert.ok(ok.ok);
  assert.match(verifyInstalled(rel, staging, { health: () => ({ ok: true, version: "2.0.0-beta.28" }), commit: () => "abc123" }).why, /reports 2.0.0-beta.28/);
  assert.match(verifyInstalled(rel, staging, { health: () => ({ ok: true, version: "2.0.0-beta.29" }), commit: () => "other" }).why, /not the frozen candidate's commit/);
  assert.match(verifyInstalled(rel, staging, { health: () => null, commit: () => "abc123" }).why, /did not answer healthy/);
  assert.equal(verifyInstalled(rel, { ...staging, status: "installed" }, { health: () => ({ ok: false }), commit: () => "abc123" }).ok, false, "a recorded value never counts");
});

test("two transports with a receipt each: Telegram's message id and a GitHub issue naming him; either one is enough, none is a stall", async () => {
  const okTg = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }), status: 200 });
  assert.deepEqual(await sendTelegram({ token: "t", chat: "c" }, "hi", okTg), { ok: true, receipt: "77" });
  assert.equal((await sendTelegram({ token: "", chat: "" }, "hi", okTg)).ok, false);
  assert.equal((await sendTelegram({ token: "t", chat: "c" }, "hi", async () => { throw new Error("down"); })).ok, false);
  const NL = String.fromCharCode(10);
  const issues = [{ user: { login: "github-actions[bot]" }, body: `@MichaelZelbel x${NL}${NL}<!-- ref:${refOf("n1")} -->`, html_url: "https://github.com/o/w/issues/3" }, { user: { login: "MichaelZelbel" }, body: `<!-- ref:${refOf("n2")} -->`, html_url: "https://github.com/o/w/issues/4" }];
  const listRun = (cmd, args) => ({ status: 0, stdout: JSON.stringify(issues) });
  assert.equal(findNotifyIssue("o/w", refOf("n1"), listRun), "https://github.com/o/w/issues/3", "an issue authored by the bot, found by its ref");
  assert.equal(findNotifyIssue("o/w", refOf("n3"), () => ({ stdout: JSON.stringify([{ user: { login: "github-actions[bot]" }, body: `no mention <!-- ref:${refOf("n3")} -->`, html_url: "u" }]) })), null, "a bot-authored issue that does not name him is no receipt");
  assert.equal(findNotifyIssue("o/w", refOf("n2"), listRun), null, "an issue opened with HIS token is no receipt: GitHub does not notify a person of their own activity");
  const calls = [];
  const noSleep = async () => {};
  assert.deepEqual(await openIssue("o/w", "t", "b", "n1", (c, a) => { calls.push(a); return listRun(c, a); }, noSleep), { ok: true, receipt: "https://github.com/o/w/issues/3" });
  assert.ok(!calls.some(a => a[0] === "workflow"), "a message already opened is never opened twice");
  let opened = false; const dispatched = [];
  const run2 = (c, a) => { if (c === "gh" && a[0] === "workflow") { dispatched.push(a.join(" ")); opened = true; return { status: 0 }; } return { status: 0, stdout: JSON.stringify(opened ? [{ user: { login: "github-actions[bot]" }, body: `@MichaelZelbel y <!-- ref:${refOf("n9")} -->`, html_url: "https://github.com/o/w/issues/9" }] : []) }; };
  assert.deepEqual(await openIssue("o/w", "A test title", "body text", "n9", run2, noSleep), { ok: true, receipt: "https://github.com/o/w/issues/9" });
  assert.match(dispatched[0], /workflow run factory-notify.yml -R o\/w -f title=A test title -f body=body text -f ref=/);
  assert.equal((await openIssue("o/w", "t", "b", "n10", () => ({ status: 1, stderr: "no", stdout: "[]" }), noSleep)).ok, false, "a dispatch that fails is no receipt");
  assert.equal((await openIssue("o/w", "t", "b", "n11", (c, a) => (a[0] === "workflow" ? { status: 0 } : { status: 0, stdout: "[]" }), noSleep, 2)).ok, false, "a workflow that has not opened the issue yet: no receipt, found by its ref next time");
  const both = await deliver({}, { title: "t", text: "x" }, { telegram: async () => ({ ok: true, receipt: "1" }), issue: () => ({ ok: true, receipt: "u" }) });
  assert.deepEqual(both.receipts, { telegram: "1", github: "u" });
  const none = await deliver({}, { title: "t", text: "x" }, { telegram: async () => ({ ok: false, why: "a" }), issue: () => ({ ok: false, why: "b" }) });
  assert.deepEqual(none.receipts, {}); assert.equal(none.failed.length, 2);
});

test("the Seen button: carried by the machine bot only, and only the owner's own tap counts; a stranger's tap and a chat-bot message do nothing", async () => {
  let sent = null;
  const okTg = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, result: { message_id: 5 } }), status: 200 }; };
  await sendTelegram({ token: "t", chat: "42", button: true }, "hi", okTg, "n:abc");
  assert.equal(sent.reply_markup.inline_keyboard[0][0].callback_data, `seen:${seenKey("n:abc")}`);
  await sendTelegram({ token: "t", chat: "42", button: false }, "hi", okTg, "n:abc"); assert.equal(sent.reply_markup, undefined, "the chat bot gets no button: another program polls it");
  const answered = [];
  const updates = { ok: true, result: [
    { update_id: 10, callback_query: { id: "q1", from: { id: 42 }, data: `seen:${seenKey("n:abc")}` } },
    { update_id: 11, callback_query: { id: "q2", from: { id: 999 }, data: `seen:${seenKey("n:other")}` } },
    { update_id: 12, message: { text: "hello" } }] };
  const fake = async (url, init) => { if (/getUpdates/.test(url)) return { json: async () => updates }; answered.push(JSON.parse(init.body).callback_query_id); return { json: async () => ({}) }; };
  const r = await pollSeen({ token: "t", owner: "42", button: true }, 0, fake);
  assert.deepEqual(r.seen, [seenKey("n:abc")]); assert.equal(r.offset, 13, "every update is consumed once"); assert.deepEqual(answered, ["q1"]);
  assert.deepEqual((await pollSeen({ token: "t", owner: "42", button: false }, 5, fake)).seen, [], "no button, no polling");
  assert.deepEqual((await pollSeen({ token: "t", owner: "42", button: true }, 5, async () => ({ json: async () => ({ ok: false, error_code: 409 }) }))).seen, [], "another poller: nothing is taken, the issue stays the fallback");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-")); fs.writeFileSync(path.join(dir, "m.env"), "BOT_TOKEN=abc\nCHAT_ID=42\n");
  assert.deepEqual(telegramCreds({ TG_MACHINE_ENV: path.join(dir, "m.env") }), { token: "abc", chat: "42", owner: "42", button: true });
});
