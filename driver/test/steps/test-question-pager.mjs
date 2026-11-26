// node driver/test/steps/test-question-pager.mjs
// test cases: 5
// Paging the owner (pager.mjs): the schedule, a receipt for every send, retries without a second message, one urgent
// issue per page, and the real channels' requests (Telegram's chat bot first, AgentMail with an idempotency key).
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { dueStage, pageStep, receipts, urgentIssue, chatCreds, sendMail, mailReplies, openUrgent, closeUrgent, urgentComments, LADDER } from "../../steps/questions/pager.mjs";

const MIN = 60000, T0 = Date.parse("2026-11-24T12:00:00Z");
const stub = (over = {}) => {
  const c = { calls: [], n: 0 };
  c.ch = {
    telegram: async t => { c.calls.push(["telegram", t]); return over.telegram ? over.telegram(t) : { ok: true, receipt: String(++c.n) }; },
    email: async m => { c.calls.push(["email", m]); return over.email ? over.email(m) : { ok: true, receipt: `m${++c.n}` }; },
    openIssue: async m => { c.calls.push(["issue", m]); return over.issue ? over.issue(m) : { ok: true, receipt: `https://github.com/o/w/issues/${++c.n}` }; },
  };
  return c;
};
const msg = { text: "Question \"f3\"", subject: "s [q:0123456789]", mail: "m", title: "t", body: "b", ref: "0123456789" };
const kinds = c => c.calls.map(x => x[0]);

testCase("the schedule: Telegram at once, email and the urgent issue at 10 minutes, both again at 60, then every 4 hours");
{
  assert.deepEqual(dueStage({ stages: [] }, T0), { n: 0, channels: ["telegram"] });
  const one = { stages: [{ at: T0 }] };
  assert.equal(dueStage(one, T0 + 9 * MIN), null);
  assert.deepEqual(dueStage(one, T0 + LADDER.emailAfterMin * MIN), { n: 1, channels: ["email", "issue"] });
  const two = { stages: [{ at: T0 }, { at: T0 + 10 * MIN }] };
  assert.equal(dueStage(two, T0 + 59 * MIN), null);
  assert.deepEqual(dueStage(two, T0 + 60 * MIN), { n: 2, channels: ["telegram", "email"] });
  const three = { stages: [{ at: T0 }, { at: T0 + 10 * MIN }, { at: T0 + 60 * MIN }] };
  assert.equal(dueStage(three, T0 + 60 * MIN + 239 * MIN), null, "never more often than every 4 hours");
  assert.deepEqual(dueStage(three, T0 + 60 * MIN + 240 * MIN), { n: 3, channels: ["telegram", "email"] });
}

testCase("a page walks its ladder with a receipt per send, and opens one urgent issue only");
{
  const c = stub(), told = {};
  await pageStep(told, msg, T0, c.ch); assert.deepEqual(kinds(c), ["telegram"]);
  assert.deepEqual(receipts(told.page).map(r => [r.channel, r.receipt]), [["telegram", "1"]], "Telegram's message_id is the receipt");
  assert.equal((await pageStep(told, msg, T0 + 5 * MIN, c.ch)).length, 0, "nothing more until 10 minutes");
  await pageStep(told, msg, T0 + 10 * MIN, c.ch); assert.deepEqual(kinds(c), ["telegram", "email", "issue"]);
  assert.equal(urgentIssue(told.page), "https://github.com/o/w/issues/3");
  assert.equal(c.calls[1][1].idem, "factory-question|0123456789|1", "the email's idempotency key: the page and its stage");
  await pageStep(told, msg, T0 + 60 * MIN, c.ch); assert.deepEqual(kinds(c).slice(3), ["telegram", "email"], "at 60 minutes, no second issue");
  await pageStep(told, msg, T0 + 300 * MIN, c.ch); assert.deepEqual(kinds(c).slice(5), ["telegram", "email"]);
  assert.equal(told.page.stages.length, 4);
}

testCase("a send without a receipt is tried again on the next run, and a channel with no settings is skipped, not retried");
{
  let tgUp = false;
  const c = stub({ telegram: () => (tgUp ? { ok: true, receipt: "77" } : { ok: false, why: "telegram http 502" }), email: () => ({ ok: false, off: true, why: "no email settings on this server" }) });
  const told = {};
  const t1 = await pageStep(told, msg, T0, c.ch);
  assert.deepEqual(t1, [{ channel: "telegram", ok: false, why: "telegram http 502" }]);
  assert.equal(receipts(told.page).length, 0, "no receipt, so not delivered");
  tgUp = true;
  await pageStep(told, msg, T0 + 5 * MIN, c.ch);
  assert.deepEqual(receipts(told.page).map(r => r.receipt), ["77"], "the same stage, sent again");
  await pageStep(told, msg, T0 + 10 * MIN, c.ch);
  await pageStep(told, msg, T0 + 15 * MIN, c.ch);
  assert.equal(c.calls.filter(x => x[0] === "email").length, 1, "an email channel with no settings is not tried again");
  assert.equal(c.calls.filter(x => x[0] === "issue").length, 1);
}

testCase("the real channels: the chat bot first, AgentMail with the owner's address, the send key and an idempotency key");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pager-"));
  fs.writeFileSync(path.join(dir, "chat.env"), "TELEGRAM_BOT_TOKEN=chat-token\nTELEGRAM_HOME_CHANNEL=42\n");
  fs.writeFileSync(path.join(dir, "machine.env"), "BOT_TOKEN=machine-token\nCHAT_ID=43\n");
  assert.deepEqual(chatCreds({ TG_ENV: path.join(dir, "chat.env"), TG_MACHINE_ENV: path.join(dir, "machine.env") }).bot, "chat", "his reply must land in the chat the relay reads");
  assert.deepEqual(chatCreds({ TG_ENV: path.join(dir, "none.env"), TG_MACHINE_ENV: path.join(dir, "machine.env") }).bot, "machine");
  fs.writeFileSync(path.join(dir, "keys.env"), "AGENTMAIL_SEND_KEY=send-1\nAGENTMAIL_READ_KEY=read-1\n");
  const env = { OWNER_EMAIL: "owner@example.com", MAIL_INBOX: "factory@agentmail.example", MAIL_API: "http://mail.invalid", KEYS_FILE: path.join(dir, "keys.env") };
  const seen = [];
  const fetch1 = async (url, init) => { seen.push({ url, init }); return { status: 200, json: async () => ({ message_id: "<m1@mail>", thread_id: "t1" }) }; };
  const r = await sendMail(env, { subject: "s", text: "x", idem: "k" }, fetch1);
  assert.deepEqual(r, { ok: true, receipt: "<m1@mail>", thread: "t1" });
  assert.equal(seen[0].url, "http://mail.invalid/v0/inboxes/factory%40agentmail.example/messages/send");
  assert.equal(seen[0].init.headers.authorization, "Bearer send-1"); assert.equal(seen[0].init.headers["idempotency-key"], "k");
  assert.equal(JSON.parse(seen[0].init.body).to, "owner@example.com");
  assert.deepEqual(await sendMail({ ...env, OWNER_EMAIL: "" }, { subject: "s", text: "x", idem: "k" }, fetch1), { ok: false, off: true, why: "no email settings on this server" });
  const fetch2 = async url => /messages\?/.test(url)
    ? { ok: true, json: async () => ({ messages: [{ message_id: "a", from: "Owner <owner@example.com>", subject: "Re: x [q:0123456789]", timestamp: "2026-11-24T12:30:00Z" }, { message_id: "b", from: "someone@else.example", subject: "Re: x [q:0123456789]" }] }) }
    : { ok: true, json: async () => ({ extracted_text: "f3: 2", timestamp: "2026-11-24T12:30:00Z" }) };
  const replies = await mailReplies(env, T0, fetch2);
  assert.deepEqual(replies.map(m => [m.id, m.text]), [["a", "f3: 2"]], "only his own replies to a page, read with the read key");
  assert.equal(await mailReplies(env, T0, async () => ({ ok: false, status: 500 })), null, "unreadable: no conclusion");
}

testCase("the urgent issue: labelled, opened once, closed, and only the owner's own comments count");
{
  const calls = [];
  const gh = (args, input) => { calls.push([args, input && JSON.parse(input)]); if (args.includes("repos/o/w/issues")) return { number: 5, html_url: "https://github.com/o/w/issues/5" }; if (/comments/.test(args[1] || "")) return [{ id: 1, user: { login: "Boss" }, created_at: "2026-11-24T12:40:00Z", body: "f3: yes" }, { id: 2, user: { login: "someone" }, created_at: "2026-11-24T12:41:00Z", body: "no" }]; return {}; };
  const env = { URGENT_REPO: "o/w", URGENT_LABEL: "alex-urgent", OWNER_LOGIN: "boss" };
  assert.deepEqual(openUrgent(env, { title: "Raise the key's limit?", body: "b" }, gh), { ok: true, receipt: "https://github.com/o/w/issues/5", number: 5 });
  assert.deepEqual(calls[1][1].labels, ["alex-urgent"]);
  assert.deepEqual(urgentComments(env, "https://github.com/o/w/issues/5", gh).map(c => c.text), ["f3: yes"]);
  assert.equal(closeUrgent(env, "https://github.com/o/w/issues/5", gh), true);
  assert.deepEqual(calls.at(-1)[1], { state: "closed", state_reason: "completed" });
  assert.deepEqual(openUrgent({ URGENT_REPO: "" }, { title: "t", body: "b" }, gh), { ok: false, off: true, why: "no urgent repository on this server" });
}
