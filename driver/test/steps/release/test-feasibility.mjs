// test cases: 8
import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import { test, runCases } from "../case-test.mjs";
import { checkFeasibility, isBugTicket, FEASIBILITY_FROM } from "../../../steps/release/feasibility.mjs";

const plan = (date = "2026-11-19") => `---\nrelease: godspeed-2.0.0-beta.30-x\nrepository: MichaelZelbel/godspeed-mission-control\n---\n\nStatus: approved by Michael on ${date} ("go")\n`;
const header = (type = "") => `Ticket for 2.0.0-beta.30 (plan item 1). Size: full. Depends on: nothing. Repository: MichaelZelbel/godspeed-mission-control. Issue: #379.${type}\n`;
const t = (name, text) => ({ name, text });

// the feature Michael rejected on 2026-11-17: a comparison of German electricity and insurance contracts
// with no named data source ("put that to the back burner until you actually know how to do this")
const CONTRACTS = `${header()}\n## Problem\n\nPeople pay too much for electricity and insurance.\n\n## Outcome\n\nGodspeed compares the person's electricity and insurance contracts with the German market and says which is cheaper.\n`;

test("a feature ticket without Built with and Proved by is refused: contract watching is the example", () => {
  const r = checkFeasibility(plan(), [t("03-contract-watching.md", CONTRACTS)]);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /03-contract-watching\.md/);
  assert.match(r.problems.join(" "), /Built with:/);
  assert.match(r.problems.join(" "), /Proved by:/);
});

test("a data source that is not named concretely does not count, nor does a placeholder", () => {
  const vague = `${CONTRACTS}\nBuilt with: public tariff and price data from comparison portals\nProved by: tests\n`;
  const r = checkFeasibility(plan(), [t("03.md", vague)]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /Built with:.*name/);
  assert.match(r.problems.join(" "), /Proved by:.*name/);
  for (const dodge of ["TBD", "to be decided", "unknown", "n/a", "some API"]) {
    const x = checkFeasibility(plan(), [t("04.md", `${CONTRACTS}\nBuilt with: ${dodge}\nProved by: \`scenario-x\`\n`)]);
    assert.equal(x.ok, false, `"${dodge}" must not pass`);
  }
});

test("a feature that names its source and its proof passes", () => {
  const ok = `${header()}\n## Outcome\n\nA watched domain tells the person when it becomes free.\n\nBuilt with: RDAP, the public registry protocol (\`https://rdap.verisign.com/com/v1/domain/<name>\`), free and without a key\nProved by: the open scenario \`domain-watch-live\`, to be written with the holdout tool \`holdout-tools/rdap-stub\`\n`;
  assert.deepEqual(checkFeasibility(plan(), [t("05-domain-watch.md", ok)]), { ok: true, problems: [], skipped: null });
  const existing = `${header()}\nBuilt with: the letters the Clerk reads (\`clerk/extract.mjs\`) and what the person says in chat\nProved by: hidden check H-41\n`;
  assert.equal(checkFeasibility(plan(), [t("06.md", existing)]).ok, true);
});

test("a proof that is still to be written must name its tool", () => {
  const noTool = `${header()}\nBuilt with: \`https://example.org/api\`\nProved by: a scenario, to be written\n`;
  assert.equal(checkFeasibility(plan(), [t("07.md", noTool)]).ok, false);
  const r = checkFeasibility(plan(), [t("07.md", noTool.replace("a scenario, to be written", "`domain-watch-live`, to be written"))]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /not with which tool/);
});

test("bug tickets are exempt", () => {
  assert.equal(isBugTicket(`${header(" Type: bug.")}\n## Problem\n`), true);
  assert.equal(isBugTicket(CONTRACTS), false);
  assert.deepEqual(checkFeasibility(plan(), [t("01-bug.md", `${header(" Type: bug.")}\n## Problem\n\nIt crashes.\n`)]), { ok: true, problems: [], skipped: null });
  const mixed = checkFeasibility(plan(), [t("01-bug.md", `${header(" Type: bug.")}`), t("02-feature.md", CONTRACTS)]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.problems.every(p => /02-feature\.md/.test(p)), true);
});

test("only an approved plan is checked, and only one approved from the day the gate exists", () => {
  assert.equal(FEASIBILITY_FROM, "2026-11-19");
  const proposed = checkFeasibility(plan().replace("approved", "proposed"), [t("03.md", CONTRACTS)]);
  assert.deepEqual([proposed.ok, proposed.skipped], [true, "the plan is not approved"]);
  const old = checkFeasibility(plan("2026-11-18"), [t("03.md", CONTRACTS)]);
  assert.deepEqual([old.ok, old.skipped], [true, "the plan was approved before the gate existed"]);
  const standing = checkFeasibility(plan().replace(/approved by Michael on .*/, "approved by standing decision (17 November 2026, bug fixes only)"), [t("03.md", CONTRACTS)]);
  assert.deepEqual([standing.ok, standing.skipped], [true, "a bug-fix release on the standing decision"]);
  const undated = checkFeasibility("---\nstatus: approved by Michael\n---\n", [t("03.md", CONTRACTS)]);
  assert.equal(undated.ok, true);
});

test("problems are plain sentences without dashes", () => {
  const r = checkFeasibility(plan(), [t("03.md", CONTRACTS)]);
  assert.doesNotMatch(r.problems.join(" "), /[—–]/);
});

test("a backticked word is not a name, and a named protocol counts", () => {
  const f = (b, p) => checkFeasibility(plan(), [t("08.md", `${header()}\nBuilt with: ${b}\nProved by: ${p}\n`)]).ok;
  assert.equal(f("`public data`", "`tests`"), false);
  assert.equal(f("`prices`", "`scenario-x`"), false);
  assert.equal(f("OAuth 2.0 against the insurer's login", "hidden check H-12"), true);
  assert.equal(f("`GraphQL`", "`holdout-tools/x.sh`"), true);
});

await runCases();
