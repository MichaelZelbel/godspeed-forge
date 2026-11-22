import { TEST_ENV } from "./env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = new URL("../briefs/", import.meta.url);
const NAMES = ["diagnose", "product", "tests", "decide", "michael", "feasibility", "ops"];
const read = n => fs.readFileSync(new URL(`${n}.md`, dir), "utf8");
// the JSON keys each brief's report schema must name
const KEYS = {
  diagnose: ["cause", "evidence", "summary"],
  product: ["cause", "summary", "items", "action", "decision", "owner_step", "michael_question"],
  tests: ["summary", "cause", "changed", "packages", "observed", "broken_tests", "product_defects", "still_blocked"],
  decide: ["summary", "decision", "post_on", "cause"],
  michael: ["ask", "question", "default", "deadline_hours", "comment"],
  feasibility: ["buildable", "summary", "evidence", "approach"],
  ops: ["fixed", "summary", "cause", "changed", "evidence"],
};

test("every brief exists and stays within 12,000 characters", () => {
  for (const n of NAMES) assert.ok(read(n).length <= 12000, `${n}.md has ${read(n).length} characters`);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort().join(), NAMES.slice().sort().map(n => `${n}.md`).join());
});

test("every brief ends with its JSON report schema and says a run without one fails", () => {
  for (const n of NAMES) {
    const t = read(n);
    const i = t.lastIndexOf("```json");
    assert.ok(i > 0, `${n}: no json schema`);
    const block = t.slice(i);
    assert.ok(/```\s*$/.test(block), `${n}: the schema is not the last thing`);
    for (const k of KEYS[n]) assert.ok(block.includes(`"${k}"`), `${n}: schema lacks "${k}"`);
    assert.match(t.slice(t.lastIndexOf("## Your report")), /without a valid report\s+counts as failed/, n);
  }
});

test("the diagnosis causes are exactly the six", () => {
  const block = read("diagnose").slice(read("diagnose").lastIndexOf("```json"));
  for (const c of ["product", "our-tests", "how", "what", "external", "feature"]) assert.ok(block.includes(`"${c}"`), c);
});

test("no brief uses an em dash", () => {
  for (const n of NAMES) assert.ok(!read(n).includes("—"), `${n}.md has an em dash`);
});

test("product keeps rules 1 to 6 and the never-list, and routes our own setup as our-tests", () => {
  const t = read("product");
  for (const r of ["1. **Decide", "2. **Repair", "3. **Narrow", "4. **A red main", "5. **A genuine product choice", "6. **Route"]) assert.ok(t.includes(r), r);
  assert.ok(t.includes("## Never"));
  assert.match(t, /cause: "our-tests"/);
  assert.ok(!t.includes("referee-repair"));
});

test("tests may write tools, never a scenario or judge, never touches the product, ends with verdict lines", () => {
  const t = read("tests");
  assert.match(t, /holdout-tools folder/);
  assert.match(t, /Never write a scenario, a judge/);
  assert.match(t, /no product code changes/);
  assert.match(t, /VERDICT <id>: PASS\|FAIL\|INCOMPLETE/);
});

test("no brief hands the product helper a path to the holdouts' contents, and tools briefs only name the tools folder", () => {
  for (const n of NAMES.filter(x => x !== "tests")) assert.ok(!read(n).includes("{{TOOLS_DIR}}"), `${n} must not see the tools folder`);
});

test("michael never sets a default or a deadline; feasibility asks only whether it can be built", () => {
  assert.match(read("michael"), /no default is applied when he is silent/);
  assert.doesNotMatch(read("michael"), /Always give a default/);
  assert.match(read("feasibility"), /can it be\s+built/);
});

test("no helper brief tells a helper to write Owner decision, Owner question or Owner repair as its own heading or commit title", () => {
  const form = /^\s{4,}Owner (decision|question|repair)/m;
  const asHeading = /starting `Owner repair|Owner question \(\{\{DATE\}\}\)|Owner decision \(\{\{DATE\}\}\)/;
  for (const n of NAMES) {
    const t = read(n);
    assert.ok(!form.test(t), `${n}.md shows an Owner heading as a form to write`);
    assert.ok(!asHeading.test(t), n);
  }
  assert.match(read("decide"), /Manager decision \(Mission Control, not\s+Michael\)/);
  assert.match(read("product"), /Mission Control repair:/);
  assert.match(read("decide"), /fixing, replacing or retiring a judge that miscounts is yours to decide/);
  assert.match(read("product"), /Never write `Owner decision`,\s+`Owner question` or `Owner repair`/);
  const rd = fs.readFileSync(new URL("../release-driver/brief.md", import.meta.url), "utf8");
  assert.ok(!form.test(rd) && !asHeading.test(rd));
  assert.match(rd, /Mission Control repair:/);
  assert.match(rd, /Manager decision \(Mission Control, not Michael\)/);
});
