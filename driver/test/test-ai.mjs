import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-ai.mjs   (offline: stand-in AI commands, a stand-in systemd)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aiDefaults, exhausted, freeToolModels, providers, launchHelper, helperResult, runHelper, commandFor, lastJsonObject, claudeEvents, renderBrief,
  markExhausted, readMarks, factoryProvider, freeModels, refreshTokens, RUNTIME_MIN, markerOf, ladderCandidates, checkJson } from "../ai.mjs";
import { FREE_MODEL_ALLOWLIST } from "../ladder.mjs";
import { guardedPaths, asForge } from "../release-driver/release-driver.mjs";

const NOW = Date.parse("2026-11-18T15:00:00Z");
const slash = p => p.replace(/\\/g, "/");

// What OpenRouter's /models said on 2026-11-18, cut down: free models with and without tools, a paid one.
const MODELS = { data: [
  { id: "inclusionai/ling-3.2-flash:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "temperature"] },
  { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
  { id: "openrouter/free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
  { id: "anthropic/claude-paid", pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] },
  { id: "google/gemma-4-31b-it:free", pricing: { prompt: "0", completion: "0", request: "0" }, supported_parameters: ["tools"] },
] };

// Real texts the three providers gave when they were used up (the OpenRouter one from the AX41 on 2026-11-18).
const CODEX_LIMIT = "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.";
const CLAUDE_LIMIT = "Claude AI usage limit reached|1763485200";
const OPENROUTER_429 = [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `google/gemma-4-31b-it:free` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." } }),
  JSON.stringify({ type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests, request id: a5c7964fbc90b59d-HEL" }),
  JSON.stringify({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests, request id: a5c7964fbc90b59d-HEL" } }),
].join("\n");
const REPORT = { cause: "how", evidence: ["the loop asked which seam to use"], summary: "A question of how; the decide helper should answer it." };

// A stand-in for codex (and for codex on OpenRouter): what it does depends on the model it is given.
const STANDIN_CODEX = `
const fs = require("fs");
const a = process.argv.slice(2); const model = a[a.indexOf("-m") + 1]; const last = a[a.indexOf("-o") + 1];
let input = ""; process.stdin.on("data", d => input += d).on("end", () => {
  if (/429/.test(model)) { process.stdout.write(${JSON.stringify(OPENROUTER_429)} + "\\n"); process.exit(1); }
  if (/limit/.test(model)) { process.stderr.write(${JSON.stringify(CODEX_LIMIT)} + "\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "gh issue view 705" } }) + "\\n");
  if (/silent/.test(model)) { fs.writeFileSync(last, "I looked but have nothing to report."); process.exit(0); }
  fs.writeFileSync(last, "Done. The prompt had " + input.length + " characters {not json}.\\n\\n\`\`\`json\\n" + JSON.stringify(${JSON.stringify(REPORT)}, null, 2) + "\\n\`\`\`\\n");
});`;
// A stand-in for Claude Code's stream-json output.
const STANDIN_CLAUDE = `
const a = process.argv.slice(2); const model = a[a.indexOf("--model") + 1];
let input = ""; process.stdin.on("data", d => input += d).on("end", () => {
  const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init" });
  if (/limit/.test(model)) { out({ type: "result", subtype: "success", is_error: true, result: ${JSON.stringify(CLAUDE_LIMIT)} }); process.exit(1); }
  if (/breach/.test(model)) out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cat /etc/godspeed-forge/keys.env" } }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr view 713" } }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "Here is my report.\\n" + JSON.stringify(${JSON.stringify(REPORT)}) });
});`;

function setup({ factory = "claude" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ai-"));
  const codex = path.join(root, "codex.cjs"), claude = path.join(root, "claude.cjs"), brief = path.join(root, "diagnose.md"), config = path.join(root, "config.yaml");
  fs.writeFileSync(codex, STANDIN_CODEX); fs.writeFileSync(claude, STANDIN_CLAUDE);
  fs.writeFileSync(brief, "Diagnose {{OBSTACLE_ID}} in {{REPO}}. Run {{RUN_ID}}, {{MINUTES}} minutes, marker {{MARKER}}. Unknown {{NOT_GIVEN}}.\n");
  fs.writeFileSync(config, `# Archon\ndefaultAssistant: ${factory}\nassistants:\n  codex:\n    model: gpt-5.6-terra\n`);
  const env = { ...aiDefaults(TEST_ENV), STATE_DIR: slash(path.join(root, "state")), WORK_ROOT: slash(path.join(root, "work")), ARCHON_CONFIG: config,
    CODEX_BIN: [process.execPath, codex], CLAUDE_BIN: [process.execPath, claude], OPENROUTER_API_KEY: "sk-or-test-not-a-real-key" };
  const active = new Set(), calls = [];
  const deps = {
    now: () => NOW,
    spawn: (file, args) => { calls.push({ file, args }); if (file === env.SYSTEMCTL && args[0] === "is-active") return { status: 0, stdout: active.has(args[1]) ? "active\n" : "inactive\n", stderr: "" }; return { status: 0, stdout: "", stderr: "" }; },
    forgeIds: () => ({ uid: 1001, gid: 1001 }), chown: () => {},
    prepare: (e, work) => { const p = guardedPaths(work); fs.rmSync(work, { recursive: true, force: true }); for (const d of [p.bin, p.ghDir, p.repoDir]) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(p.ghDir, "hosts.yml"), "token"); return p; },
    prepareScratch: work => { fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(path.join(work, "tmp"), { recursive: true }); },
    fetchJson: async () => { deps.fetched = (deps.fetched || 0) + 1; return MODELS; },
  };
  return { root, env, deps, brief, active, calls };
}
const launch = (s, over = {}) => launchHelper(s.env, { unit: over.unit || "factory-helper-0123abcd45-1", kind: over.kind || "diagnose", provider: over.provider || "codex", model: over.model || "gpt-5.6-terra",
  briefFile: s.brief, context: over.context || { OBSTACLE_ID: "0123abcd45" }, ...over }, s.deps);

test("limit texts of all three providers mean 'the next one'; a warning or an ordinary error does not", () => {
  for (const t of [CODEX_LIMIT, CLAUDE_LIMIT, "You've hit your limit · resets 5pm (UTC)", "5-hour limit reached ∙ resets 3pm", "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
    "exceeded retry limit, last status: 429 Too Many Requests", "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly", "Insufficient credits"]) assert.equal(exhausted(t), true, t);
  for (const t of ["Model metadata for `nvidia/nemotron-3-ultra-550b-a55b:free` not found. Defaulting to fallback metadata", "error: could not find file", "", "Reading additional input from stdin..."]) assert.equal(exhausted(t), false, t);
});

test("free models: only zero-priced ones that can call tools and are on the allowlist, in its order; never OpenRouter's own router", () => {
  // the built-in allowlist: free models confirmed at 100B parameters or more (2026-11-18 19:25)
  assert.deepEqual(freeToolModels(MODELS.data), ["nvidia/nemotron-3-ultra-550b-a55b:free"]);
  assert.deepEqual(freeToolModels(MODELS.data, ["google/gemma-4-31b-it:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/lyria-3-pro-preview", "anthropic/claude-paid"]),
    ["google/gemma-4-31b-it:free", "nvidia/nemotron-3-ultra-550b-a55b:free"]);
  // the router picks any free model itself, a small one too: never, even when a setting names it
  assert.deepEqual(freeToolModels(MODELS.data, ["openrouter/free"]), []);
  assert.deepEqual(aiDefaults(TEST_ENV).OPENROUTER_ALLOW, FREE_MODEL_ALLOWLIST);
  assert.deepEqual(aiDefaults({ FD_OPENROUTER_ALLOW: "a/b:free, c/d:free" }).OPENROUTER_ALLOW, ["a/b:free", "c/d:free"]);
});

test("the factory's own subscription is never first; the other one, then it, and no free model while either answers", async () => {
  for (const [factory, first, second] of [["claude", "codex", "claude"], ["codex", "claude", "codex"], [null, "codex", "claude"]]) {
    const s = setup();
    const list = await providers(s.env, factory, s.deps);
    assert.deepEqual(list.slice(0, 2).map(p => p.name), [first, second]);
    assert.notEqual(list[0].name, factory);
    assert.deepEqual(list.slice(2), [], "no free model while a subscription is available");
    assert.equal(list[0].model, first === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5-5");
  }
  const s = setup({ factory: "claude" });
  assert.equal(factoryProvider(s.env), "claude");
  // in the ladder's terms: usual models first, then the stronger ones, alternating
  assert.deepEqual(ladderCandidates(await providers(s.env, "claude", s.deps)).map(c => `${c.provider} ${c.model}`), ["codex gpt-5.6-terra", "claude claude-sonnet-5-5", "codex gpt-5.6-sol", "claude claude-opus-5-5"]);
});

test("both subscriptions used up: only the allowlisted free models; without an OpenRouter key, none", async () => {
  const s = setup();
  markExhausted(s.env, { name: "codex" }, "You've hit your usage limit", NOW);
  assert.deepEqual((await providers(s.env, "claude", s.deps)).map(p => p.name), ["claude"], "one subscription left: still no free model");
  markExhausted(s.env, { name: "claude" }, "Claude AI usage limit reached", NOW);
  const list = await providers(s.env, "claude", s.deps);
  assert.deepEqual(list.map(p => `${p.name} ${p.model}`), ["openrouter nvidia/nemotron-3-ultra-550b-a55b:free"]);
  assert.deepEqual(ladderCandidates(list).map(c => c.model), ["nvidia/nemotron-3-ultra-550b-a55b:free"]);
  assert.deepEqual(await providers(s.env, "claude", { ...s.deps, key: () => "" }), []);
});

test("a free model list kept from before the allowlist is filtered when it is read", async () => {
  const s = setup();
  fs.mkdirSync(s.env.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(s.env.STATE_DIR, "openrouter-models.json"), JSON.stringify({ at: new Date(NOW - 60000).toISOString(),
    models: ["inclusionai/ling-3.2-flash:free", "liquid/lfm-3-1.7b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "recursive/flint-v1.0:free", "openrouter/free"] }));
  assert.deepEqual(await freeModels(s.env, s.deps), ["nvidia/nemotron-3-ultra-550b-a55b:free"]);
  assert.equal(s.deps.fetched, undefined, "the kept list is still fresh: no fetch");
});

test("the free model list is fetched live and kept for 6 hours", async () => {
  const s = setup();
  await freeModels(s.env, s.deps); await freeModels(s.env, s.deps);
  assert.equal(s.deps.fetched, 1);
  await freeModels(s.env, { ...s.deps, now: () => NOW + 7 * 3600 * 1000 });
  assert.equal(s.deps.fetched, 2);
  // a failed fetch keeps the last list instead of none
  const list = await freeModels(s.env, { ...s.deps, now: () => NOW + 20 * 3600 * 1000, fetchJson: async () => { throw new Error("HTTP 503"); } });
  assert.equal(list[0], "nvidia/nemotron-3-ultra-550b-a55b:free");
});

test("a dry run fetches the free models but keeps nothing", async () => {
  const s = setup();
  const env = { ...s.env, STATE_DIR: path.join(s.env.STATE_DIR, "dry"), DRY: true };
  const list = await freeModels(env, s.deps);
  assert.ok(list.length > 0);
  assert.equal(fs.existsSync(env.STATE_DIR), false);
});

test("a usage limit from the first provider moves the next helper to the other one", async () => {
  const s = setup();
  const before = await providers(s.env, "claude", s.deps);
  assert.equal(before[0].name, "codex");
  const h = await launch(s, { model: "gpt-limit" });
  await runHelper(h.dir, { env: s.env });
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.state, "failed");
  assert.equal(r.exhausted, true);
  assert.match(r.reason, /^no report/);
  const after = await providers(s.env, "claude", s.deps);
  assert.equal(after[0].name, "claude");
  assert.ok(!after.some(p => p.name === "codex"));
  // the mark runs out: a later round tries codex again
  const later = await providers(s.env, "claude", { ...s.deps, now: () => NOW + 31 * 60 * 1000 });
  assert.equal(later[0].name, "codex");
});

test("Claude's usage limit is read from its stream-json result too", async () => {
  const s = setup();
  const h = await launch(s, { provider: "claude", model: "claude-limit" });
  await runHelper(h.dir, { env: s.env });
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.exhausted, true);
  assert.ok(readMarks(s.env).claude);
});

test("a 429 from OpenRouter moves to the next allowed free model, not off OpenRouter", async () => {
  const s = setup();
  s.deps.fetchJson = async () => ({ data: [
    { id: "x/model-429:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "y/model-ok:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] });
  s.env.OPENROUTER_ALLOW = ["x/model-429:free", "y/model-ok:free"];
  const h = await launch(s, { provider: "openrouter", model: "x/model-429:free" });
  const secret = path.join(s.env.STATE_DIR, "secrets", "factory-helper-0123abcd45-1.env");
  assert.equal(fs.readFileSync(secret, "utf8"), "OPENROUTER_API_KEY=sk-or-test-not-a-real-key\n");
  await runHelper(h.dir, { env: s.env });
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.exhausted, true);
  assert.equal(r.marked, "openrouter:x/model-429:free");
  assert.equal(fs.existsSync(secret), false, "the key file goes when the helper is collected");
  assert.deepEqual((await providers(s.env, "claude", s.deps)).map(p => p.name), ["codex", "claude"], "the subscriptions answer: no free model");
  markExhausted(s.env, { name: "codex" }, "You've hit your usage limit", NOW);
  markExhausted(s.env, { name: "claude" }, "Claude AI usage limit reached", NOW);
  const list = await providers(s.env, "claude", s.deps);
  assert.deepEqual(list.map(p => `${p.name} ${p.model}`), ["openrouter y/model-ok:free"]);
  // the free models' daily cap takes all of OpenRouter out until midnight UTC
  markExhausted(s.env, { name: "openrouter", model: "y/model-ok:free" }, "Rate limit exceeded: free-models-per-day", NOW);
  assert.deepEqual(await providers(s.env, "claude", s.deps), []);
  assert.equal(readMarks(s.env).openrouter.until, "2026-11-19T00:00:00.000Z");
});

test("the drill's FD_FORCE_EXHAUSTED=codex makes a codex helper report its limit", async () => {
  const s = setup();
  s.env.FORCE_EXHAUSTED = "codex";
  const h = await launch(s);
  await runHelper(h.dir, { env: s.env });
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.exhausted, true);
  assert.equal((await providers(s.env, "claude", s.deps))[0].name, "claude");
});

test("a helper that finishes writes report.json from the last JSON object of its answer", async () => {
  const s = setup();
  const h = await launch(s);
  s.active.add("factory-helper-0123abcd45-1");
  assert.equal(helperResult(s.env, "factory-helper-0123abcd45-1", s.deps).state, "running");
  await runHelper(h.dir, { env: s.env });
  s.active.delete("factory-helper-0123abcd45-1");
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.state, "done");
  assert.deepEqual(r.report, REPORT);
  assert.equal(r.exhausted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, "report.json"), "utf8")), REPORT);
  assert.equal(fs.existsSync(h.work), false, "the run folder (clone, login) is removed");
  // the prompt is the brief with its placeholders filled
  const prompt = fs.readFileSync(path.join(h.dir, "prompt.md"), "utf8");
  assert.match(prompt, /Diagnose 0123abcd45 in MichaelZelbel\/godspeed-mission-control\. Run factory-helper-0123abcd45-1, 15 minutes, marker <!-- factory-driver:factory-helper-0123abcd45-1 -->\. Unknown \{\{NOT_GIVEN\}\}\./);
  // collected once: a second call gives the same answer
  assert.deepEqual(helperResult(s.env, "factory-helper-0123abcd45-1", s.deps), r);
});

test("a helper that never writes a report (killed, crashed, timed out) counts as failed: no report", async () => {
  const s = setup();
  await launch(s, { kind: "tests" });
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.state, "failed");
  assert.match(r.reason, /^no report: the helper ended without finishing/);
  assert.equal(r.exhausted, false);
  // an answer without a JSON object is no report either
  const s2 = setup();
  const h2 = await launch(s2, { model: "gpt-silent" });
  await runHelper(h2.dir, { env: s2.env });
  const r2 = helperResult(s2.env, "factory-helper-0123abcd45-1", s2.deps);
  assert.equal(r2.state, "failed");
  assert.match(r2.reason, /^no report: the AI ended \(exit 0\) without a valid report/);
});

test("the audit reads Claude's commands too: reading a key file fails the helper and withholds its report", async () => {
  const s = setup();
  const h = await launch(s, { provider: "claude", model: "claude-breach" });
  await runHelper(h.dir, { env: s.env });
  const r = helperResult(s.env, "factory-helper-0123abcd45-1", s.deps);
  assert.equal(r.state, "failed");
  assert.equal(r.report, undefined);
  assert.match(r.reason, /^audit: touched a key or token/);
});

test("a tests helper may work in its tools folder; a login, or the tools folder for any other helper, still fails the audit", async () => {
  // seen in the drill on 2026-11-18: both tests helpers were failed for reading their own tools folder
  const s = setup();
  const TOOLS = "/home/godspeed-forge/.archon/holdout-tools/MichaelZelbel-godspeed-mission-control";
  const ev = cmd => JSON.stringify({ type: "item.started", item: { type: "command_execution", command: cmd } });
  const finish = (h, lines) => { fs.writeFileSync(path.join(h.dir, "events.jsonl"), lines.join("\n")); fs.writeFileSync(path.join(h.dir, "exit.json"), '{"code":0}'); fs.writeFileSync(path.join(h.dir, "report.json"), '{"summary":"s"}'); };
  const run = async (n, kind, lines) => { const h = await launch(s, { kind, unit: `factory-helper-7e57000001-${n}`, context: { OBSTACLE_ID: "7e57000001", TOOLS_DIR: TOOLS } }); finish(h, lines); return helperResult(s.env, h.unit, s.deps); };
  // a changed file is placed by the audit's POSIX paths, so that part runs on Linux (the AX41) only
  const change = process.platform === "win32" ? [] : [JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: `${TOOLS}/H-35/run.sh` }] } })];
  const ok = await run(1, "tests", [ev(`ls ${TOOLS}/H-35 && bash ${TOOLS}/H-35/run.sh`), ...change]);
  assert.equal(ok.state, "done", JSON.stringify(ok.breaches));
  const login = await run(2, "tests", [ev(`ls ${TOOLS} && cat /home/godspeed-forge/.config/gh/hosts.yml`)]);
  assert.equal(login.state, "failed");
  assert.match(login.reason, /touched a key or token|factory's own files/);
  const other = await run(3, "ops", [ev(`ls ${TOOLS}/H-35`)]);
  assert.equal(other.state, "failed", "only the tests helper owns the tools");
});

test("a tests helper may read its project's hidden scenarios but never change them", async () => {
  const s = setup();
  const TOOLS = "/home/godspeed-forge/.archon/holdout-tools/MichaelZelbel-godspeed-mission-control", HOLD = "/home/godspeed-forge/holdouts/godspeed-mission-control";
  const ev = cmd => JSON.stringify({ type: "item.started", item: { type: "command_execution", command: cmd } });
  const finish = (h, lines) => { fs.writeFileSync(path.join(h.dir, "events.jsonl"), lines.join("\n")); fs.writeFileSync(path.join(h.dir, "exit.json"), '{"code":0}'); fs.writeFileSync(path.join(h.dir, "report.json"), '{"summary":"s"}'); };
  const run = async (n, kind, lines) => { const h = await launch(s, { kind, unit: `factory-helper-7e57000002-${n}`, context: { OBSTACLE_ID: "7e57000002", TOOLS_DIR: TOOLS, HOLDOUTS_DIR: HOLD } }); finish(h, lines); return helperResult(s.env, h.unit, s.deps); };
  const read = await run(1, "tests", [ev(`grep -E '^## H-' ${HOLD}/HOLDOUT.md`)]);
  assert.equal(read.state, "done", JSON.stringify(read.breaches));
  const write = await run(2, "tests", [JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: `${HOLD}/HOLDOUT.md` }] } })]);
  assert.equal(write.state, "failed");
  const product = await run(3, "diagnose", [ev(`cat ${HOLD}/HOLDOUT.md`)]);
  assert.equal(product.state, "failed", "never the product side");
});

test("the unit: systemd-run as the factory user, its kind's time limit, a clean environment, no key on the command line", async () => {
  const s = setup();
  await launch(s, { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", kind: "product", unit: "factory-helper-ffee001122-3" });
  const call = s.calls.find(c => c.file === "systemd-run");
  const a = call.args;
  assert.ok(a.includes("--unit=factory-helper-ffee001122-3"));
  assert.ok(a.includes("--uid=godspeed-forge") && a.includes("--gid=godspeed-forge") && a.includes("--collect"));
  assert.equal(a[a.indexOf("-p", a.indexOf("--quiet")) + 1], `RuntimeMaxSec=${RUNTIME_MIN.product * 60}`);
  assert.ok(a.some(x => x.startsWith("EnvironmentFile=") && x.endsWith("/secrets/factory-helper-ffee001122-3.env")));
  assert.ok(!a.join(" ").includes("sk-or-test"), "the key is never on the command line");
  assert.ok(a.includes("--setenv=HOME=/home/godspeed-forge"));
  // the factory account's own network namespace, its resolver, and no host sockets
  const props = a.filter((x, i) => a[i - 1] === "-p");
  for (const p of ["NetworkNamespacePath=/run/netns/godspeed-forge", "BindReadOnlyPaths=/usr/local/lib/godspeed-forge/factory-sandbox/resolve:/run/systemd/resolve",
    "InaccessiblePaths=-/run/tailscale", "InaccessiblePaths=-/run/docker.sock"]) assert.ok(props.includes(p), p);
  // and a plain command as the factory user (the guarded setup's clone, the second check) runs inside it too
  assert.deepEqual(asForge(s.env, ["id"]).flat().slice(0, 8), ["ip", "netns", "exec", "godspeed-forge", "runuser", "-u", "godspeed-forge", "--"]);
  assert.ok(a.some(x => /^--setenv=PATH=\/home\/godspeed-forge\/\.local\/bin:.*\/bin:/.test(x)), "the guard's shims and Claude's folder on PATH");
  assert.ok(a.some(x => x.startsWith("--setenv=RD_MARKER=<!-- factory-driver:factory-helper-ffee001122-3 -->")));
  assert.deepEqual(a.slice(-3).map((x, i) => (i === 0 ? path.basename(x) : x)), ["ai.mjs", "run", slash(path.join(s.env.STATE_DIR, "helpers", "factory-helper-ffee001122-3"))]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(s.env.STATE_DIR, "secrets", "factory-helper-ffee001122-3.env")).mode & 0o777, 0o600);
    // the factory user must be able to walk to its own folder (found live: a 0700 helpers folder stopped it)
    assert.equal(fs.statSync(path.join(s.env.STATE_DIR, "helpers")).mode & 0o755, 0o755);
  }
  // a tests helper gets no GitHub login and no guard
  await launch(s, { kind: "tests", unit: "factory-helper-ffee001122-4" });
  const t = s.calls.filter(c => c.file === "systemd-run").at(-1).args;
  assert.ok(t.some(x => /^--setenv=GH_CONFIG_DIR=.*\/no-gh$/.test(x)));
  assert.ok(!t.some(x => x.startsWith("--setenv=RD_")));
  assert.equal(t[t.indexOf("-p", t.indexOf("--quiet")) + 1], "RuntimeMaxSec=7200");
  // a name is used once, and only helper names are accepted
  await assert.rejects(launch(s, { kind: "tests", unit: "factory-helper-ffee001122-4" }), /launched before/);
  await assert.rejects(launch(s, { unit: "godspeed-integrated-notebook" }), /not a helper unit name/);
});

test("two helpers never share a run folder, and collecting one never removes the other's", async () => {
  const s = setup();
  const a = await launch(s, { unit: "factory-helper-aaaa000001-1" });
  s.active.add("factory-helper-aaaa000001-1");
  const b = await launch(s, { unit: "factory-helper-bbbb000002-1" });
  assert.notEqual(a.work, b.work);
  // a finished, not yet collected: its slot goes to c; collecting a leaves c's folder alone
  s.active.delete("factory-helper-aaaa000001-1"); s.active.add("factory-helper-bbbb000002-1");
  const c = await launch(s, { unit: "factory-helper-cccc000003-1" });
  assert.equal(c.work, a.work);
  helperResult(s.env, "factory-helper-aaaa000001-1", s.deps);
  assert.equal(fs.existsSync(c.work), true);
});

test("the route to OpenRouter is Codex with the provider settings", () => {
  const env = aiDefaults(TEST_ENV);
  const cmd = commandFor(env, { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", cwd: "/w/repo" }, "/s/helpers/u");
  assert.deepEqual(cmd, ["/usr/local/bin/codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "danger-full-access", "-m", "nvidia/nemotron-3-ultra-550b-a55b:free", "-C", "/w/repo",
    "-o", "/s/helpers/u/last.txt", "-c", "model_provider=openrouter", "-c", "model_providers.openrouter.name=OpenRouter", "-c", "model_providers.openrouter.base_url=https://openrouter.ai/api/v1",
    "-c", "model_providers.openrouter.env_key=OPENROUTER_API_KEY", "-"]);
  assert.deepEqual(commandFor(env, { provider: "claude", model: "claude-sonnet-5-5", cwd: "/w" }, "/s"), ["/home/godspeed-forge/.local/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-5-5", "--dangerously-skip-permissions"]);
});

test("the report is the last whole JSON object, whatever braces come before it", () => {
  assert.deepEqual(lastJsonObject("I tried {a thing}. ```json\n{\"cause\": \"product\", \"evidence\": [\"a } in a string\", \"{x}\"], \"nested\": {\"k\": 1}}\n```"), { cause: "product", evidence: ["a } in a string", "{x}"], nested: { k: 1 } });
  assert.deepEqual(lastJsonObject("{\"a\":1} then {\"b\":{\"c\":2}}"), { b: { c: 2 } });
  assert.equal(lastJsonObject("no json here {broken"), null);
  assert.equal(lastJsonObject("[1,2]"), null);
  assert.equal(claudeEvents('{"type":"result","is_error":false,"result":"ok {\\"x\\":1}"}').final, 'ok {"x":1}');
  assert.equal(renderBrief("a {{X}} b {{Y}}", { X: "1" }), "a 1 b {{Y}}");
  assert.equal(markerOf("factory-helper-ab-1"), "<!-- factory-driver:factory-helper-ab-1 -->");
});

test("every round renews the login of a running guarded helper older than 20 minutes, and only that", async () => {
  const s = setup();
  const h = await launch(s, { kind: "product" });
  s.active.add("factory-helper-0123abcd45-1");
  const renewed = [];
  const hosts = path.join(h.work, "gh", "hosts.yml");
  assert.deepEqual(refreshTokens(s.env, { ...s.deps, now: () => fs.statSync(hosts).mtimeMs + 5 * 60000, renew: (e, d) => renewed.push(d) }), []);
  assert.deepEqual(refreshTokens(s.env, { ...s.deps, now: () => fs.statSync(hosts).mtimeMs + 21 * 60000, renew: (e, d) => renewed.push(d) }), ["factory-helper-0123abcd45-1"]);
  assert.deepEqual(renewed, [slash(path.join(h.work, "gh"))]);
});

// ---------------------------------------------------------------- Task 8: the second check rotates too
test("the second check goes through the same rotation as the helpers: a used-up provider is marked and the next one answers", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fd-check-"));
  const env = { ...aiDefaults(TEST_ENV), STATE_DIR: state, FORGE_NETNS: "godspeed-forge", KEYS_FILE: path.join(state, "none") };
  const seen = [];
  const spawn = (file, args, opts) => {
    seen.push({ file, args, env: opts.env, input: opts.input });
    if (args.includes("-p")) return { status: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: CLAUDE_LIMIT }), stderr: "" };
    const o = args[args.indexOf("-o") + 1];
    fs.writeFileSync(o, 'Checked. {"approve": true, "reason": "keeps the bar"}');
    return { status: 0, stdout: "", stderr: "" };
  };
  const list = [{ name: "claude", model: "claude-sonnet-5-5" }, { name: "codex", model: "gpt-5.6-terra" }, { name: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" }];
  const run = checkJson(env, list, { spawn, now: () => NOW, key: () => "sk-or-secret" });
  const r = run("Is this decision safe?", { type: "object" });
  assert.deepEqual(r.out, { approve: true, reason: "keeps the bar" });
  assert.equal(r.trouble, "");
  assert.equal(seen.length, 2, "codex answered, OpenRouter was not needed");
  assert.equal(seen[0].file, "ip", "as the factory user, inside its network namespace");
  assert.deepEqual(seen[0].args.slice(0, 6), ["netns", "exec", "godspeed-forge", "runuser", "-u", "godspeed-forge"]);
  assert.ok(seen[1].args.includes("read-only"), "the check reads, it never writes");
  assert.match(seen[1].input, /Is this decision safe\?/);
  assert.ok(Date.parse(readMarks(env).claude.until) > NOW, "claude is marked used up for the helpers too");
});

test("the second check's OpenRouter key goes through the environment, never the command line; no answer anywhere is 'no answer'", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fd-check-"));
  const env = { ...aiDefaults(TEST_ENV), STATE_DIR: state, FORGE_NETNS: "godspeed-forge" };
  const seen = [];
  const spawn = (file, args, opts) => { seen.push({ args, env: opts.env }); return { status: 1, stdout: "", stderr: "boom" }; };
  const r = checkJson(env, [{ name: "openrouter", model: "m:free" }], { spawn, now: () => NOW, key: () => "sk-or-secret" })("q", {});
  assert.equal(r.out, null);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].args.join(" ").includes("sk-or-secret"));
  assert.equal(seen[0].env.OPENROUTER_API_KEY, "sk-or-secret");
  assert.ok(seen[0].args.includes("model_provider=openrouter"));
});
