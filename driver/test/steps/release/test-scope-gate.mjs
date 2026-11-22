import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { checkScope } from "../../../steps/release/scope-gate.mjs";
import { PRODUCT_REPO } from "../../../steps/release/staging.mjs";

const id = "godspeed-2.0.0-beta.18.1-first-day-works";
const version = "2.0.0-beta.18.1";
const ticket = `releases/${id}/tickets/01-first-day.md`;
const approved = `---\nstatus: approved by Michael\n---\n## Tickets\n`;
const done = `Status: done (merge ${"a".repeat(40)})\n`;
const amendment = { release: id, version, approvedBy: "Michael", words: "Ship this one later", approvalRef: "chat:reply-12345", approvedAt: "2026-11-06T14:00:00Z", deferredTickets: ["01-first-day.md"] };
const candidate = "b".repeat(40);
const merged = async (repo, sha, tip) => repo === PRODUCT_REPO && sha === "a".repeat(40) && tip === candidate;

function records({ plan = approved, files = [ticket], body = "Status: in review\n", scope = null } = {}) {
  return {
    findRelease: () => id,
    read: (file) => file.endsWith("plan.md") ? plan : file === ticket ? body : null,
    ticketFiles: () => files,
    json: () => scope,
  };
}

test("freeze refuses an unfinished approved ticket", async () => {
  await assert.rejects(() => checkScope(records(), PRODUCT_REPO, version, candidate, merged), /open approved-plan tickets/);
});

test("a merge commit in the candidate's ancestry closes the ticket", async () => {
  await assert.doesNotReject(() => checkScope(records({ body: done }), PRODUCT_REPO, version, candidate, merged));
  await assert.rejects(() => checkScope(records({ body: `Status: done (merge ${"c".repeat(40)})\n` }), PRODUCT_REPO, version, candidate, merged), /open approved-plan tickets/);
});

test("a ticket's Repository line may end in punctuation, as the planner writes it", async () => {
  const body = `Status: done, merge ${"a".repeat(40)} (#1)\n\n# Ticket 01\n\nRepository: ${PRODUCT_REPO}, base branch \`main\`.\n`;
  await assert.doesNotReject(() => checkScope(records({ body }), PRODUCT_REPO, version, candidate, merged));
});

test("a named, approved scope amendment can defer that ticket", async () => {
  await assert.doesNotReject(() => checkScope(records({ scope: amendment }), PRODUCT_REPO, version, candidate, merged));
  await assert.rejects(() => checkScope(records({ scope: { ...amendment, deferredTickets: [] } }), PRODUCT_REPO, version, candidate, merged), /open approved-plan tickets/);
  await assert.rejects(() => checkScope(records({ scope: { ...amendment, approvedBy: "assistant" } }), PRODUCT_REPO, version, candidate, merged), /open approved-plan tickets/);
  await assert.rejects(() => checkScope(records({ scope: { ...amendment, approvalRef: "" } }), PRODUCT_REPO, version, candidate, merged), /open approved-plan tickets/);
});

test("the release cannot hide its ticket directory or approval", async () => {
  await assert.rejects(() => checkScope(records({ files: [] }), PRODUCT_REPO, version, candidate, merged), /no ticket files/);
  await assert.rejects(() => checkScope(records({ plan: "## Tickets\n" }), PRODUCT_REPO, version, candidate, merged), /no approved release plan/);
});

// ---- the release driver's own decision under the plan's dead-end rule
const RULE = "an item that reaches a dead end leaves the release, the rest ships";
const planWithRule = `---\nstatus: approved by Michael\n---\n## Tickets\n\nA release step: ${RULE}.\n`;
const ticket2 = `releases/${id}/tickets/02-second.md`;
const driver = {
  release: id, version, decidedBy: "release-driver", authority: "plan-rule", words: RULE,
  approvalRef: `releases/${id}/plan.md: Status: approved by Michael`, approvedAt: "2026-11-17T08:00:00Z",
  deferredTickets: ["02-second.md"], reasons: { "02-second.md": ["issue #5 still open after two send-backs"] },
};
function two({ plan = planWithRule, scope } = {}) {
  return {
    findRelease: () => id,
    read: (file) => file.endsWith("plan.md") ? plan : file === ticket ? done : file === ticket2 ? "Status: in review\n" : null,
    ticketFiles: () => [ticket, ticket2],
    json: () => scope,
  };
}
const check = (r) => checkScope(r, PRODUCT_REPO, version, candidate, merged);

test("the driver's plan-rule amendment moves an open ticket out", async () => {
  await assert.doesNotReject(() => check(two({ scope: driver })));
});

test("the driver's amendment is refused when its words are not in the plan", async () => {
  await assert.rejects(() => check(two({ scope: { ...driver, words: "an item that hits a dead end is dropped and the others go out" } })), /not in the plan/);
});

test("the driver's amendment is refused when the plan is not approved", async () => {
  await assert.rejects(() => check(two({ plan: planWithRule.replace("approved by Michael", "draft"), scope: driver })), /no approved release plan/);
});

test("the driver never moves every ticket out", async () => {
  const r = {
    ...two({ scope: { ...driver, deferredTickets: ["01-first-day.md", "02-second.md"], reasons: { "01-first-day.md": ["x y z"], "02-second.md": ["x y z"] } } }),
    read: (file) => file.endsWith("plan.md") ? planWithRule : "Status: in review\n",
  };
  await assert.rejects(() => check(r), /nothing to release/);
});

test("the driver's amendment is refused for a ticket that does not exist or has no evidence", async () => {
  await assert.rejects(() => check(two({ scope: { ...driver, deferredTickets: ["09-none.md"], reasons: { "09-none.md": ["x"] } } })), /does not have/);
  await assert.rejects(() => check(two({ scope: { ...driver, reasons: {} } })), /no evidence/);
});

test("a person's decision and a later driver entry in one file both stand; the old flat file is unchanged", async () => {
  const ticket3 = `releases/${id}/tickets/03-third.md`;
  const person = { ...amendment, deferredTickets: ["03-third.md"] };
  const r = {
    ...two({ scope: { ...person, amendments: [driver] } }),
    ticketFiles: () => [ticket, ticket2, ticket3],
    read: (file) => file.endsWith("plan.md") ? planWithRule : file === ticket ? done : "Status: in review\n",
  };
  await assert.doesNotReject(() => check(r));
  await assert.doesNotReject(() => checkScope(records({ scope: amendment }), PRODUCT_REPO, version, candidate, merged));
});

test("a short or off-topic quote is not the plan's rule, and the plan's line wrapping does not matter", async () => {
  await assert.rejects(() => check(two({ scope: { ...driver, words: "approved" } })), /dead-end rule/);
  await assert.rejects(() => check(two({ scope: { ...driver, reasons: { "02-second.md": [""] } } })), /no evidence/);
  const wrapped = planWithRule.replace("leaves the release,", "leaves the\nrelease,");
  await assert.doesNotReject(() => check(two({ plan: wrapped, scope: driver })));
});

test("the factory driver's entry (2026-11-18, the shape its cut writes) moves an open ticket out like the release driver's did", async () => {
  const fd = { ...driver, decidedBy: "factory-driver", decidedAt: "2026-11-18T16:00:00Z",
    reasons: { "02-second.md": { item: 2, issue: 5, url: "https://github.com/x/y/issues/5", why: "two different attempts failed because of the feature itself", decidedAt: "2026-11-18T16:00:00Z", evidence: ["feasibility: the platform has no such call"] } } };
  await assert.doesNotReject(() => check(two({ scope: { release: id, version, amendments: [fd] } })));
  await assert.rejects(() => check(two({ scope: { release: id, version, amendments: [{ ...fd, words: "it goes" }] } })), /dead-end rule/, "it stands only on the plan's own rule");
});

test("an entry in the array that names no one never moves a ticket", async () => {
  await assert.rejects(() => check(two({ scope: { release: id, version, amendments: [{ ...driver, decidedBy: "release_driver" }] } })), /names no one/);
});

test("the driver's own evidence record (why plus evidence list) counts as evidence; an empty one does not", async () => {
  const rec = { item: 2, issue: 5, rule: "a", why: "authorized twice, nothing merged in 12 hours", evidence: [{ at: "2026-11-17T00:00:00Z", url: "https://example.invalid/5#c1", words: "Owner decision" }] };
  await assert.doesNotReject(() => check(two({ scope: { ...driver, reasons: { "02-second.md": rec } } })));
  await assert.rejects(() => check(two({ scope: { ...driver, reasons: { "02-second.md": { ...rec, evidence: [] } } } })), /no evidence/);
  await assert.rejects(() => check(two({ scope: { ...driver, reasons: { "02-second.md": { ...rec, why: "" } } } })), /no evidence/);
});

test("freeze refuses an approved plan whose feature ticket names no source and no proof", async () => {
  const plan = `---\nstatus: approved by Michael on 2026-11-19 ("go")\n---\n## Tickets\n`;
  const feature = `Ticket for 2.0.0-beta.30 (plan item 1). Size: full.\n\n## Outcome\nCompare German electricity contracts.\n${done}`;
  await assert.rejects(() => checkScope(records({ plan, body: feature }), PRODUCT_REPO, version, candidate, merged), /do not say what they are built with/);
  const ok = `${feature}Built with: the tariff API at \`https://api.example.org/v1/tariffs\`\nProved by: hidden check H-50\n`;
  await assert.doesNotReject(() => checkScope(records({ plan, body: ok }), PRODUCT_REPO, version, candidate, merged));
  const bug = `Ticket for 2.0.0-beta.30 (plan item 1). Type: bug.\n\n## Problem\nCrash.\n${done}`;
  await assert.doesNotReject(() => checkScope(records({ plan, body: bug }), PRODUCT_REPO, version, candidate, merged));
});
