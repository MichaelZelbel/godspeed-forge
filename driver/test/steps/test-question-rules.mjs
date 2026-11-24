// node driver/test/steps/test-question-rules.mjs
// test cases: 6
// The plain rules of 2026-11-24: which factory question pages the owner (severity.mjs, page-words.json) and which
// option Mission Control takes for every other one (choices.mjs). No model anywhere: the same text gives the same answer.
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import path from "node:path"; import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseOptions, parseRecommendation, pickOption, leadingLabel, itemsOf } from "../../steps/questions/choices.mjs";
import { severityOf, categoryOf, CATEGORIES, WORDS } from "../../steps/questions/severity.mjs";
import { parseQuestions } from "../../steps/questions/factory-owner-questions.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "questions-2026-11-24");
const issue = f => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const godspeed = parseQuestions(issue("godspeed-531.json").body);
const second = parseQuestions(issue("cherishly-31.json").body);
const find = (list, start) => { const q = list.find(x => x.heading.startsWith(start)); assert.ok(q, `there is a question "${start}"`); return q; };

testCase("the options and the recommendation are read in both forms the manager writes");
{
  assert.deepEqual(parseOptions("Options: (a) keep the heart; (b) use the same people icon as the card's header, or none. Recommendation: (b). Default after x").map(o => [o.label, o.text]),
    [["a", "keep the heart"], ["b", "use the same people icon as the card's header, or none"]]);
  assert.deepEqual(parseOptions("Options: raise the key's monthly limit, or put a new key in the `X` secret. Recommendation: raise the limit.").map(o => o.text),
    ["raise the key's monthly limit", "put a new key in the `X` secret"]);
  assert.deepEqual(parseOptions("intro\n\n- **A.** Keep it as it is.\n- **B.** Give the whole site a dark theme (a new item).\n\nRecommendation: **A** for now").map(o => [o.label, o.text]),
    [["a", "Keep it as it is"], ["b", "Give the whole site a dark theme (a new item)"]]);
  assert.deepEqual(parseOptions("Should it?\n\n1. Yes, always.\n2. Only when asked.\n\nRecommended: 2").map(o => o.label), ["1", "2"], "the release driver's own numbered choices");
  assert.equal(parseRecommendation("Options: (a) x; (b) y. Recommendation: (b). Default after 2026-11-24 10:15 UTC: wait.").text, "(b).");
  assert.equal(parseRecommendation("Recommendation: **A** for now, **B** later. This is about how the site looks, so there is no default.").label, "a");
  assert.equal(parseRecommendation("What Mission Control would do: keep the page as it is.").text, "keep the page as it is.");
  assert.equal(leadingLabel("a new key"), null, "an article is never a label");
  assert.equal(leadingLabel("(c): it keeps the rule"), "c");
  assert.deepEqual(itemsOf("One land-only lap (#958 / PR #990, #950 / PR #953)"), [958, 990, 950, 953]);
}

testCase("today's Godspeed issue: 26 questions, and only the one that would spend money pages the owner");
{
  assert.equal(godspeed.length, 26);
  const pages = godspeed.filter(q => severityOf(q).page);
  assert.deepEqual(pages.map(q => q.heading), ["Raise or replace the scenarios' OpenRouter key (monthly limit reached)"]);
  assert.equal(severityOf(pages[0]).category, "money");
  for (const q of godspeed.filter(q => !pages.includes(q))) assert.ok(severityOf(q).pick, `"${q.heading}" has an option to take`);
  // the examples of the standing instruction: minor look and feel, scope and behaviour are decided at once
  const heart = severityOf(find(godspeed, "The empty Recent People card"));
  assert.equal(heart.page, false); assert.equal(heart.pick.how, "recommended"); assert.equal(heart.pick.option.label, "b");
  const time = severityOf(find(godspeed, "Should a moment carry a time of day?"));
  assert.equal(time.page, false); assert.match(time.pick.text, /add an optional time/);
  assert.equal(severityOf(find(godspeed, "Should a newly watched domain")).page, false, "a notice the product shows its own user is product behaviour, not sending to other people");
  assert.equal(severityOf(find(godspeed, "Public verification routes")).page, false, "the word public alone publishes nothing");
  assert.equal(severityOf(find(godspeed, "Should other records carry")).pick.option.label, "a", "(a) for now");
}

testCase("today's second project: 4 numbered questions, none pages (privacy wording, scope, a closed account's own delete button)");
{
  assert.deepEqual(second.map(q => q.number), [7, 8, 9, 10]);
  for (const q of second) assert.equal(severityOf(q).page, false, `"${q.heading}" is decided by Mission Control`);
  assert.equal(severityOf(find(second, "A closed account")).pick.option.label, "a");
  assert.equal(severityOf(find(second, "May an assistant")).pick.option.label, "a", "the option that keeps the mission");
  assert.match(severityOf(find(second, "#60")).pick.text, /privacy §6 and §8 reworded/, "privacy wording is Mission Control's; its going live is behind the owner's release go");
}

testCase("a mission change is never taken for him, and with no recommendation the most reversible option is");
{
  const mission = pickOption({ heading: "Assistants", body: "- **A.** Keep it person-only.\n- **B.** Let an assistant do it (a schema change and a mission amendment).\n\nRecommendation: **B**." });
  assert.equal(mission.how, "keeps the mission"); assert.equal(mission.option.label, "a");
  const none = pickOption({ heading: "Old notes", body: "Options: (a) delete the old notes; (b) keep them for now; (c) move them elsewhere." });
  assert.equal(none.how, "most reversible"); assert.equal(none.option.label, "b");
  assert.equal(pickOption({ heading: "Status", body: "For your information, no decision needed." }), null, "nothing to pick from: the driver's decide helper");
}

testCase("only money, publishing or sending to others, and deleting people's data page; the word list is one file");
{
  assert.deepEqual(CATEGORIES, ["money", "publish", "delete"]);
  for (const c of CATEGORIES) assert.ok(WORDS[c].why && WORDS[c].patterns.length, `${c} says why and has words`);
  const page = body => severityOf({ heading: "A question", body });
  assert.equal(page("Options: (a) upgrade to the paid plan; (b) wait. Recommendation: (a).").category, "money");
  assert.equal(page("Options: (a) publish the release now; (b) wait. Recommendation: (a).").category, "publish");
  assert.equal(page("Options: (a) email all users about it; (b) say nothing. Recommendation: (a).").category, "publish");
  assert.equal(page("Options: (a) permanently delete inactive accounts; (b) keep them. Recommendation: (a).").category, "delete");
  assert.equal(page("Options: (a) wait; (b) publish now. Recommendation: (a).").page, false, "the action taken is what counts, not an option left aside");
  assert.equal(page("Options: (a) make the button blue; (b) keep it grey. Recommendation: (a).").page, false);
  assert.equal(severityOf({ heading: "querino.ai is still on an old build: publish what `main` holds (only you can)", body: "It needs your go." }).category, "publish", "with nothing to pick from, a question that asks to publish pages");
  assert.equal(categoryOf("raise the limit").category, "money");
}

testCase("the rule is plain code: severity.mjs and choices.mjs start no program and ask no model");
{
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "steps", "questions");
  for (const f of ["severity.mjs", "choices.mjs"]) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/child_process|spawn|fetch\(|model/.test(t.replace(/\/\/.*$/gm, "")), `${f} is plain code`);
  }
}
