// The factory driver's helpers run on whichever AI is free (2026-11-18, plan Task 5).
//
// WHY. The release driver ran one AI (Codex on Michael's ChatGPT plan) inside its own process and
// stopped when that plan's allowance ran out. The factory itself runs on one subscription (Claude since
// D-423), so a helper that uses the same one competes with the factory for the same allowance.
//
// WHAT.
//   providers()     the order to try: the subscription the factory does NOT use, then the other one;
//                   only when both reported their limit, the free OpenRouter models on the allowlist
//                   that can call tools (fetched live, kept 6 hours; 2026-11-18 19:25: helpers had slid
//                   down to 1.7B models while both subscriptions answered).
//                   A provider (or one free model) that reported its limit is left out for a while, so
//                   a limit means "the next one", never "stop".
//   launchHelper()  one helper = one transient systemd unit `factory-helper-<obstacle>-<n>` as the
//                   factory user, with a clean environment and RuntimeMaxSec from its kind, so systemd
//                   kills a hung helper. It returns at once; the next round collects the result.
//   helperResult()  running, done (a report) or failed (no report, an audit breach, a limit); a limit
//                   is recorded so providers() moves on.
//   the runner      `node ai.mjs run <helper dir>` is what the unit executes: it runs the AI CLI with
//                   the prompt on stdin and turns the last JSON object of its final answer into
//                   report.json.
// Helpers that touch GitHub run in the release driver's guarded setup (a fresh clone, a builder-App
// token for one repository, gh and git behind the guard, the audit afterwards), imported from
// ../release-driver/release-driver.mjs, never copied.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexTrouble, forgeArgv } from "./release-driver/release-driver-owner-steps.mjs";
import { PROTECTED_DEFAULT } from "./release-driver/release-driver-guard.mjs";
import { prepareGuardedRun, cleanupGuardedRun, guardedPaths, guardedEnv, writeLogin, mintToken, auditEvents, asForgeSh, FORGE_PATH, SYSTEM_PATH } from "./release-driver/release-driver.mjs";
import { FREE_MODEL_ALLOWLIST } from "./ladder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60 * 1000, HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();

// Every helper kind and its time limit in minutes (the plan's Global Constraints).
export const RUNTIME_MIN = { product: 90, tests: 120, decide: 20, diagnose: 15, feasibility: 30, ops: 30, michael: 20 };
// Helpers that read or write GitHub run behind the guard with a builder token for the one repository.
// `tests` never gets product write access and `ops` needs no GitHub, so neither gets a token.
export const GUARDED_KINDS = ["product", "diagnose", "decide", "feasibility", "michael"];
export const UNIT_RE = /^factory-helper-[a-z0-9]{1,40}-\d{1,6}$/;
export const MARKER_PREFIX = "factory-driver:";
export const markerOf = unit => `<!-- ${MARKER_PREFIX}${unit} -->`;
export const DRIVER_EMAIL = "factory-driver@factory.invalid";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const MODELS_CACHE_HOURS = 6;
export const SLOTS = 8; // run folders are reused: the AI CLIs record every folder they trust

const bins = v => { if (Array.isArray(v)) return v; const s = String(v || "").trim(); if (s.startsWith("[")) return JSON.parse(s); return [s]; };
export const aiDefaults = (e = process.env) => ({
  REPO: e.FD_REPO || "owner/repository",
  STATE_DIR: e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver",
  FORGE_USER: e.FORGE_USER || "factory",
  SOURCE_CHECKOUT: e.FD_SOURCE_CHECKOUT || "/home/factory/repository",
  WORK_ROOT: e.FD_WORK_ROOT || "/home/factory/factory-driver",
  GUARD: e.FD_GUARD || path.join(HERE, "release-driver", "release-driver-guard.mjs"),
  TOKEN_SCRIPT: e.FD_TOKEN_SCRIPT || "/usr/local/bin/gh-app-token.mjs",
  KEYS_FILE: e.FD_KEYS_FILE || "/etc/godspeed-forge/keys-file",
  ARCHON_CONFIG: e.FD_ARCHON_CONFIG || "/home/factory/.archon/config.yaml",
  CODEX_BIN: bins(e.FD_CODEX_BIN || "/usr/local/bin/codex"),
  CLAUDE_BIN: bins(e.FD_CLAUDE_BIN || "/home/factory/.local/bin/claude"),
  NODE: e.FD_NODE || process.execPath,
  SYSTEMD_RUN: e.FD_SYSTEMD_RUN || "systemd-run",
  SYSTEMCTL: e.FD_SYSTEMCTL || "systemctl",
  CODEX_MODEL: e.FD_CODEX_MODEL || "gpt-5.6-terra",
  CODEX_STRONG_MODEL: e.FD_CODEX_STRONG_MODEL || "gpt-5.6-sol",
  CLAUDE_MODEL: e.FD_CLAUDE_MODEL || "claude-sonnet-5-5",
  CLAUDE_STRONG_MODEL: e.FD_CLAUDE_STRONG_MODEL || "claude-opus-5-5",
  OPENROUTER_MODELS_URL: e.FD_OPENROUTER_MODELS_URL || `${OPENROUTER_BASE}/models`,
  // the only free models a helper may run on (ladder.mjs FREE_MODEL_ALLOWLIST: 100B parameters or more), in the order to try
  OPENROUTER_ALLOW: e.FD_OPENROUTER_ALLOW ? e.FD_OPENROUTER_ALLOW.split(",").map(s => s.trim()).filter(Boolean) : [...FREE_MODEL_ALLOWLIST],
  EXHAUSTED_MINUTES: Number(e.FD_EXHAUSTED_MINUTES || 30), // a subscription that reported its limit is tried again after this
  MODEL_BUSY_MINUTES: Number(e.FD_MODEL_BUSY_MINUTES || 15), // one free model that answered 429
  HELPER_MEMORY_MAX: e.FD_HELPER_MEMORY_MAX || "8G", // the owner's own services come first
  FORCE_EXHAUSTED: e.FD_FORCE_EXHAUSTED || "", // the drill: "codex" makes every codex helper report its limit
  // The factory account lives in its own network namespace (2026-11-18): every helper unit joins it,
  // and every plain command as that user runs through `ip netns exec` (forgeArgv). "" turns it off.
  FORGE_NETNS: e.FD_FORGE_NETNS !== undefined ? e.FD_FORGE_NETNS : "",
  SANDBOX_RESOLVE: e.FD_SANDBOX_RESOLVE || "",
});
// The unit properties that put a helper into the factory's namespace and keep host sockets from it.
// The names a brief says in the owner's own words (the settings), so no brief carries a name of its own.
export const serverVars = (e = process.env) => ({ OWNER_LOGIN: e.FD_OWNER_LOGIN || "the owner", BUILDER_LOGIN: `${e.FD_BUILDER_APP || "builder"}[bot]`, RELEASE_LOGIN: `${e.FD_RELEASE_APP || "release"}[bot]`,
  NEVER_TOUCH: [...String(e.FD_NEVER_TOUCH || "").split(",").map(x => x.trim()).filter(Boolean), ...(e.FD_NEVER_TOUCH_PATTERN ? [`anything matching ${e.FD_NEVER_TOUCH_PATTERN}`] : [])].join(", ") || "the services and folders the settings name as never touched (none are named)" });
export const sandboxProps = env => (env.FORGE_NETNS ? [`NetworkNamespacePath=/run/netns/${env.FORGE_NETNS}`, ...(env.SANDBOX_RESOLVE ? [`BindReadOnlyPaths=${env.SANDBOX_RESOLVE}:/run/systemd/resolve`] : []),
  "InaccessiblePaths=-/run/tailscale", "InaccessiblePaths=-/run/docker.sock"] : []);

// ---------------------------------------------------------------- limits (pure)
// The texts that mean "this provider (or this model) is used up for now; take the next one".
// Codex: codexTrouble's quota words. Claude Code: its usage-limit lines and the API's 429 and 529.
// OpenRouter: 429 from the router or upstream, the free models' daily cap, credits.
const LIMIT_TEXTS = [
  /claude ai usage limit reached/i, /you've hit your (?:usage )?limit/i, /\b(?:5-hour|weekly|session|daily|opus|sonnet) limit\b/i,
  /rate_limit_error/i, /overloaded_error/i, /\b529\b/, /too many requests/i, /rate[- ]limit(?:ed)?/i,
  /free-models-per-day/i, /temporarily rate-limited upstream/i, /insufficient credits/i, /requires more credits/i, /credit balance is too low/i,
];
export const exhausted = text => codexTrouble(text) === "quota" || LIMIT_TEXTS.some(re => re.test(String(text || "")));
// The whole OpenRouter account is used up for the day (not just one model).
const DAILY_CAP = /free-models-per-day|insufficient credits|requires more credits|credit balance is too low/i;

// ---------------------------------------------------------------- providers
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; } };
function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
// "claude" or "codex": what Cole's factory runs on now (Archon's defaultAssistant), or null.
export function factoryProvider(env) {
  try { const m = /^defaultAssistant:\s*["']?(\w+)/m.exec(fs.readFileSync(env.ARCHON_CONFIG, "utf8")); return m ? m[1].toLowerCase() : null; } catch { return null; }
}
// OpenRouter's own router picks any free model itself, a 1.7B one too: never a helper's model.
const ROUTER = "openrouter/free";
const allowed = (allow, id) => id !== ROUTER && (allow || FREE_MODEL_ALLOWLIST).includes(id);
// The free models that can call tools and are on the allowlist, in the allowlist's order (pure).
// models: OpenRouter's /models data.
export function freeToolModels(models, allow = FREE_MODEL_ALLOWLIST) {
  const zero = v => v === undefined || v === null || Number(v) === 0;
  const ok = new Set((models || []).filter(m => m && m.id && m.pricing && zero(m.pricing.prompt) && zero(m.pricing.completion) && zero(m.pricing.request)
    && Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools")).map(m => m.id));
  return [...new Set(allow)].filter(id => ok.has(id) && allowed(allow, id));
}
const modelsCache = env => path.join(env.STATE_DIR, "openrouter-models.json");
async function fetchJson(url) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
  try { const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); }
}
// Fetched live, kept MODELS_CACHE_HOURS; a failed fetch keeps the last list (however old) instead of none.
// The kept list is filtered by the allowlist when it is read, so one kept from before it never brings a
// small model back.
export async function freeModels(env, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const allow = env.OPENROUTER_ALLOW || FREE_MODEL_ALLOWLIST;
  const cache = readJson(modelsCache(env), null);
  const kept = () => ((cache && Array.isArray(cache.models) && cache.models) || []).filter(id => allowed(allow, id));
  if (cache && Array.isArray(cache.models) && now - Date.parse(cache.at) < MODELS_CACHE_HOURS * HOUR) return kept();
  try {
    const data = await (deps.fetchJson || fetchJson)(env.OPENROUTER_MODELS_URL);
    const models = freeToolModels((data && data.data) || [], allow);
    if (!env.DRY) writeJson(modelsCache(env), { at: iso(now), models }); // a dry run keeps nothing
    return models;
  } catch { return kept(); }
}
// The OpenRouter key: the driver's own environment, else the root-only keys file. Never logged.
export function openrouterKey(env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  try { const m = /^OPENROUTER_API_KEY=(.*)$/m.exec(fs.readFileSync(env.KEYS_FILE, "utf8")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; } catch { return ""; }
}
const marksFile = env => path.join(env.STATE_DIR, "exhausted.json");
export const markKey = p => (p.name === "openrouter" && p.model ? `openrouter:${p.model}` : p.name);
export function readMarks(env) { return readJson(marksFile(env), {}); }
const marked = (marks, p, now) => [p.name, markKey(p)].some(k => marks[k] && Date.parse(marks[k].until) > now);
// Records that a provider (or one free model) reported its limit. -> the mark's key
export function markExhausted(env, p, text, now = Date.now()) {
  const marks = readMarks(env);
  let key = markKey(p), until = now + env.EXHAUSTED_MINUTES * MIN;
  if (p.name === "openrouter") {
    if (DAILY_CAP.test(String(text || ""))) { key = "openrouter"; const d = new Date(now); until = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
    else until = now + env.MODEL_BUSY_MINUTES * MIN;
  }
  for (const [k, v] of Object.entries(marks)) if (!v || Date.parse(v.until) <= now) delete marks[k];
  marks[key] = { at: iso(now), until: iso(until), why: String(text || "").replace(/\s+/g, " ").trim().slice(0, 200) };
  writeJson(marksFile(env), marks);
  return key;
}
// -> [{name, model, strong?}] in the order to try, without those that reported their limit. The
// subscription the factory runs on is never first. A free model only when both subscriptions reported
// their limit, and only one on the allowlist. Empty: no AI is reachable right now (the driver's `no-ai`
// obstacle); the marks run out by themselves, so a later round tries again.
export async function providers(env, factoryProv, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const first = factoryProv === "codex" ? "claude" : "codex";
  const second = first === "codex" ? "claude" : "codex";
  const sub = name => (name === "codex" ? { name, model: env.CODEX_MODEL, strong: env.CODEX_STRONG_MODEL } : { name, model: env.CLAUDE_MODEL, strong: env.CLAUDE_STRONG_MODEL });
  const marks = readMarks(env);
  const subs = [sub(first), sub(second)].filter(p => !marked(marks, p, now));
  if (subs.length) return subs;
  if (!(deps.key || openrouterKey)(env)) return [];
  return (await freeModels(env, deps)).map(model => ({ name: "openrouter", model })).filter(p => !marked(marks, p, now));
}
// providers() in the ladder's terms (ladder.mjs ctx.candidates: [{provider, model}] in order): each
// subscription's usual model, then their stronger models, then the free models.
export const ladderCandidates = list => [
  ...list.filter(p => p.name !== "openrouter").map(p => ({ provider: p.name, model: p.model })),
  ...list.filter(p => p.name !== "openrouter" && p.strong).map(p => ({ provider: p.name, model: p.strong })),
  ...list.filter(p => p.name === "openrouter").map(p => ({ provider: p.name, model: p.model })),
];

// ---------------------------------------------------------------- the command (pure)
// What the unit runs for one provider: [file, ...args]; the prompt goes on stdin.
export function commandFor(env, run, dir) {
  const last = path.posix.join(dir, "last.txt");
  const codex = [...bins(env.CODEX_BIN), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "danger-full-access", "-m", run.model, "-C", run.cwd, "-o", last];
  if (run.provider === "codex") return [...codex, "-"];
  if (run.provider === "openrouter") return [...codex, "-c", "model_provider=openrouter", "-c", "model_providers.openrouter.name=OpenRouter",
    "-c", `model_providers.openrouter.base_url=${OPENROUTER_BASE}`, "-c", "model_providers.openrouter.env_key=OPENROUTER_API_KEY", "-"];
  if (run.provider === "claude") return [...bins(env.CLAUDE_BIN), "-p", "--output-format", "stream-json", "--verbose", "--model", run.model, "--dangerously-skip-permissions"];
  throw new Error(`unknown provider: ${run.provider}`);
}
// The last balanced JSON object in a text (the briefs end every answer with one). -> object or null
export function lastJsonObject(text) {
  const s = String(text || "");
  // the brace that closes the object opened at `start`, strings and escapes respected; -1 when none
  const close = start => {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
      if (c === "\"") inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
    }
    return -1;
  };
  let found = null;
  for (let i = s.indexOf("{"); i >= 0; i = s.indexOf("{", i + 1)) {
    const end = close(i);
    if (end < 0) continue;
    let o = null; try { o = JSON.parse(s.slice(i, end + 1)); } catch { continue; }
    if (o && typeof o === "object" && !Array.isArray(o)) { found = o; i = end; } // a whole object: the next one starts after it
  }
  return found;
}
// Claude Code's stream-json events -> the final answer text, the error text, and the commands and
// file changes in Codex's event shape, so the release driver's audit reads both the same way.
export function claudeEvents(text) {
  let final = "", error = "";
  const codexShaped = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "result") { final = String(e.result || ""); if (e.is_error) error += `${final}\n`; }
    if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (!c || c.type !== "tool_use") continue;
        const input = c.input || {};
        if (c.name === "Bash") codexShaped.push({ type: "item.started", item: { type: "command_execution", command: String(input.command || "") } });
        else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name) && (input.file_path || input.notebook_path)) codexShaped.push({ type: "item.completed", item: { type: "file_change", changes: [{ path: String(input.file_path || input.notebook_path) }] } });
      }
    }
    if (e.type === "error" || (e.type === "system" && e.subtype === "api_error")) error += `${JSON.stringify(e).slice(0, 500)}\n`;
  }
  return { final, error, events: codexShaped.map(x => JSON.stringify(x)).join("\n") };
}
// Codex's --json events -> the error messages it reported (a 429, a usage limit, a failed turn).
export function codexErrors(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "error" && e.message) out.push(String(e.message));
    if (e.type === "turn.failed" && e.error && e.error.message) out.push(String(e.error.message));
  }
  return out.join("\n");
}
// {{KEY}} placeholders of a brief, from the context; unknown ones stay as they are.
export function renderBrief(template, vars) {
  return String(template).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in vars ? (typeof vars[k] === "string" ? vars[k] : JSON.stringify(vars[k], null, 2)) : all));
}

// ---------------------------------------------------------------- the second check
// The second check of an owner decision (release-driver-owner-steps secondCheck) through the same
// rotation as the helpers (2026-11-18 ruling: a Codex-only check left decisions waiting whenever Codex
// was used up). One read-only run per provider, as the factory user in its namespace, the prompt on
// stdin; a limit marks that provider (so the helpers skip it too) and the next one is asked; the first
// answer holding a JSON object counts. -> (prompt, schema) => {out, trouble}, codexJson's shape.
export function checkJson(env, list, deps = {}) {
  const spawnIt = deps.spawn || ((file, args, opts) => {
    const r = spawnSync(file, args, { encoding: "utf8", timeout: 20 * MIN, maxBuffer: 16 * 1024 * 1024, ...opts });
    return { status: r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? r.error.message : "") };
  });
  const now = () => (deps.now ? deps.now() : Date.now());
  return (prompt, schema) => {
    const ask = `${prompt}\n\nAnswer with exactly one JSON object that matches this JSON schema, and nothing else: ${JSON.stringify(schema)}`;
    let trouble = "other";
    for (const p of list || []) {
      const dir = fs.mkdtempSync(path.join(deps.tmp || os.tmpdir(), "fd-check-"));
      try {
        fs.chmodSync(dir, 0o777); // the factory user writes its answer here
        const out = path.join(dir, "out.txt");
        const childEnv = { PATH: SYSTEM_PATH, HOME: `/home/${env.FORGE_USER}`, LANG: "C.UTF-8" };
        let argv;
        if (p.name === "claude") argv = [...bins(env.CLAUDE_BIN), "-p", "--output-format", "json", "--model", p.model, "--tools", ""];
        else {
          argv = [...bins(env.CODEX_BIN), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-m", p.model, "-C", dir, "-o", out];
          if (p.name === "openrouter") {
            const key = (deps.key || openrouterKey)(env);
            if (!key) continue;
            argv.push("-c", "model_provider=openrouter", "-c", "model_providers.openrouter.name=OpenRouter", "-c", `model_providers.openrouter.base_url=${OPENROUTER_BASE}`, "-c", "model_providers.openrouter.env_key=OPENROUTER_API_KEY");
            childEnv.OPENROUTER_API_KEY = key; // through the environment, never the command line
          }
          argv.push("-");
        }
        const [file, args] = forgeArgv(env, argv);
        const r = spawnIt(file, args, { input: ask, env: childEnv });
        let text = "", errText = `${r.stderr || ""}\n`;
        if (p.name === "claude") {
          try { const j = JSON.parse(r.stdout); text = String(j.result || ""); if (j.is_error) { errText += text; text = ""; } } catch { errText += r.stdout || ""; }
        } else { try { text = fs.readFileSync(out, "utf8"); } catch {} errText += codexErrors(r.stdout); }
        const obj = lastJsonObject(text);
        if (obj) return { out: obj, trouble: "", provider: p.name, model: p.model };
        if (exhausted(errText)) { markExhausted(env, p, errText, now()); trouble = "quota"; }
      } catch { /* the next provider */ } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
    return { out: null, trouble };
  };
}

// ---------------------------------------------------------------- launching
export const helperDir = (env, unit) => path.posix.join(String(env.STATE_DIR).replace(/\\/g, "/"), "helpers", unit);
const secretFile = (env, unit) => path.posix.join(String(env.STATE_DIR).replace(/\\/g, "/"), "secrets", `${unit}.env`);
function sys(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 120000, env: { PATH: SYSTEM_PATH }, ...opts });
  return { status: r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? r.error.message : "") };
}
function forgeIds(env) {
  const u = sys("id", ["-u", env.FORGE_USER]), g = sys("id", ["-g", env.FORGE_USER]);
  if (u.status !== 0 || g.status !== 0) throw new Error(`no user ${env.FORGE_USER}`);
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}
// A unit is running while systemd says active or activating (reloading and deactivating count too).
export function unitActive(env, unit, deps = {}) {
  const r = (deps.spawn || sys)(env.SYSTEMCTL, ["is-active", unit]);
  return /^(active|activating|deactivating|reloading)\b/.test(String(r.stdout || "").trim());
}
// The helper a run folder belongs to ("" when none).
const slotOwner = work => { try { return fs.readFileSync(path.posix.join(work, ".unit"), "utf8").trim(); } catch { return ""; } };
// The first run folder no running helper holds.
function freeSlot(env, deps) {
  for (let k = 1; k <= SLOTS; k++) {
    const work = path.posix.join(String(env.WORK_ROOT).replace(/\\/g, "/"), `slot-${k}`);
    const owner = slotOwner(work);
    if (!owner || !unitActive(env, owner, deps)) return work;
  }
  throw new Error(`every one of the ${SLOTS} run folders is held by a running helper`);
}

// Writes the prompt and starts the helper's unit; returns at once. A unit name is used once.
// context: values for the brief's {{PLACEHOLDERS}} (an object), or a text added under "Context".
export async function launchHelper(env, { unit, kind, provider, model, briefFile, context = {}, cwd, runtimeMaxSec, protectedPaths = PROTECTED_DEFAULT, ownerIssue = "" }, deps = {}) {
  if (!UNIT_RE.test(String(unit))) throw new Error(`not a helper unit name: ${unit}`);
  if (!RUNTIME_MIN[kind]) throw new Error(`unknown helper kind: ${kind}`);
  if (!["codex", "claude", "openrouter"].includes(provider)) throw new Error(`unknown provider: ${provider}`);
  const now = deps.now ? deps.now() : Date.now();
  const spawnSys = deps.spawn || sys;
  const dir = helperDir(env, unit);
  if (fs.existsSync(path.join(dir, "run.json"))) throw new Error(`helper ${unit} was launched before`);
  const ids = deps.forgeIds ? deps.forgeIds() : forgeIds(env);
  const own = f => (deps.chown || ((p, u, g) => fs.chownSync(p, u, g)))(f, ids.uid, ids.gid);
  // the folders above stay open to walk through (a recursive mkdir would give them the helper's 0700,
  // and the factory user could not reach its own folder: found live on the AX41, 2026-11-18)
  fs.mkdirSync(path.posix.dirname(dir), { recursive: true, mode: 0o755 });
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  own(dir); // the helper writes its events, its answer and its report here
  const seconds = Math.max(60, Math.round(Number(runtimeMaxSec) || RUNTIME_MIN[kind] * 60));
  const work = freeSlot(env, deps);
  const marker = markerOf(unit);
  const guarded = GUARDED_KINDS.includes(kind);
  let envList, runCwd;
  if (guarded) {
    const p = (deps.prepare || prepareGuardedRun)(env, work, { gitName: "Godspeed factory driver", gitEmail: DRIVER_EMAIL });
    // the guard's log lives with the helper's record, so it outlives the run folder
    envList = guardedEnv(env, { ...p, guardLog: path.posix.join(dir, "guard.log") }, { marker, ownerIssue, protectedPaths });
    runCwd = cwd || p.repoDir;
  } else {
    (deps.prepareScratch || (w => asForgeSh(env, `set -eu; umask 077; rm -rf "${w}"; mkdir -p "${w}/tmp" "${w}/no-gh"`)))(work);
    // no GitHub login at all: an empty gh folder, no token in the environment
    envList = [`PATH=${FORGE_PATH}`, `GH_CONFIG_DIR=${work}/no-gh`, "GH_PROMPT_DISABLED=1", "GIT_TERMINAL_PROMPT=0", `TMPDIR=${work}/tmp`];
    runCwd = cwd || work;
  }
  fs.writeFileSync(path.posix.join(work, ".unit"), `${unit}\n`, { mode: 0o644 }); own(path.posix.join(work, ".unit"));
  // Claude Code lives in the factory user's own bin folder
  envList = envList.map(v => (v.startsWith("PATH=") ? `PATH=/home/${env.FORGE_USER}/.local/bin:${v.slice(5)}` : v));
  const vars = { RUN_ID: unit, NOW: `${iso(now).slice(0, 16).replace("T", " ")} UTC`, DATE: iso(now).slice(0, 10), MINUTES: String(Math.round(seconds / 60)), MODEL: `${provider} ${model}`,
    MARKER: marker, RUN_DIR: work, REPO: env.REPO, ...serverVars(), OWNER_ISSUE: String(ownerIssue || "?"), PROTECTED: (protectedPaths || []).join(", "), ...(typeof context === "object" && context ? context : {}) };
  let prompt = renderBrief(fs.readFileSync(briefFile, "utf8"), vars);
  if (typeof context === "string" && context.trim()) prompt += `\n\n## Context\n\n${context.trim()}\n`;
  fs.writeFileSync(path.join(dir, "prompt.md"), prompt, { mode: 0o600 }); own(path.join(dir, "prompt.md"));
  const force = String(env.FORCE_EXHAUSTED || "").split(",").map(s => s.trim()).includes(provider);
  // the tests helper's own folder (the hidden-check tools): the audit counts it as part of its run folder
  const toolsDir = kind === "tests" && context && typeof context === "object" && /^\/home\/[\w.-]+\/\.archon\/holdout-tools\/[\w.-]+$/.test(String(context.TOOLS_DIR || "")) ? String(context.TOOLS_DIR) : undefined;
  // and it may read (never change) its project's hidden scenarios, which the product side never sees
  const holdoutsDir = kind === "tests" && context && typeof context === "object" && /^\/home\/[\w.-]+\/holdouts\/[\w.-]+$/.test(String(context.HOLDOUTS_DIR || "")) ? String(context.HOLDOUTS_DIR) : undefined;
  const run = { unit, kind, provider, model, cwd: runCwd, work, guarded, marker, startedAt: iso(now), runtimeMaxSec: seconds, forceExhausted: force || undefined, toolsDir, holdoutsDir,
    command: commandFor(env, { provider, model, cwd: runCwd }, dir) };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", { mode: 0o644 });
  const args = [`--unit=${unit}`, `--uid=${env.FORGE_USER}`, `--gid=${env.FORGE_USER}`, "--collect", "--quiet",
    `--description=Godspeed factory driver: ${kind} helper (${provider} ${model})`,
    "-p", `RuntimeMaxSec=${seconds}`, "-p", "TimeoutStopSec=30", "-p", "Nice=10", "-p", `MemoryMax=${env.HELPER_MEMORY_MAX}`, "-p", `WorkingDirectory=${runCwd}`,
    ...sandboxProps(env).flatMap(p => ["-p", p]),
    `--setenv=HOME=/home/${env.FORGE_USER}`, "--setenv=LANG=C.UTF-8", ...envList.map(v => `--setenv=${v}`)];
  if (provider === "openrouter") {
    // the key reaches the helper through a root-only file systemd reads, never through the command line
    const key = (deps.key || openrouterKey)(env);
    if (!key) throw new Error("no OpenRouter key (OPENROUTER_API_KEY in the keys file)");
    const sf = secretFile(env, unit);
    fs.mkdirSync(path.dirname(sf), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sf, `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
    args.push("-p", `EnvironmentFile=${sf}`);
  }
  args.push(env.NODE, path.posix.join(HERE.replace(/\\/g, "/"), "ai.mjs"), "run", dir);
  const r = spawnSys(env.SYSTEMD_RUN, args);
  if (r.status !== 0) {
    try { fs.rmSync(secretFile(env, unit), { force: true }); } catch {}
    if (guarded) cleanupGuardedRun(guardedPaths(work), null);
    throw new Error(`systemd-run refused ${unit}: ${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}`);
  }
  return { unit, dir, work, provider, model, kind };
}

// ---------------------------------------------------------------- collecting
// -> {state: "running"|"done"|"failed", report?, exhausted?, reason?, trouble?, breaches?, refusals?, ...}
// A finished helper is collected once: its login and run folder go, its key file goes, and the
// result is kept in result.json, so a second call answers the same without doing anything again.
export function helperResult(env, unit, deps = {}) {
  const dir = helperDir(env, unit);
  const run = readJson(path.join(dir, "run.json"), null);
  if (!run) return { state: "failed", reason: "no report: the driver has no record of this helper", exhausted: false };
  const kept = readJson(path.join(dir, "result.json"), null);
  if (kept) return kept;
  if (unitActive(env, unit, deps)) return { state: "running", provider: run.provider, model: run.model, kind: run.kind };
  const now = deps.now ? deps.now() : Date.now();
  const read = f => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  const exit = readJson(path.join(dir, "exit.json"), null);
  const report = readJson(path.join(dir, "report.json"), null);
  const out = read("events.jsonl"), err = read("stderr.txt");
  let events = out, errorText = err;
  if (run.provider === "claude") { const c = claudeEvents(out); events = c.events; errorText += `\n${c.error}`; }
  else errorText += `\n${codexErrors(out)}`;
  // a tests helper works in its tools folder (its brief says so): for the audit that folder is part of
  // its run folder; every other rule still holds (seen in the drill on 2026-11-18: without this, every
  // tests helper failed for reading its own tools)
  if (run.kind === "tests" && run.toolsDir) events = events.split(run.toolsDir).join("../tools"); // the audit reads it from the clone: <run folder>/tools
  // reading the hidden scenarios is allowed to a tests helper: in its commands only (a changed file there still fails)
  if (run.kind === "tests" && run.holdoutsDir) events = events.split("\n").map(l => (l.includes('"command_execution"') ? l.split(run.holdoutsDir).join("../hidden-read") : l)).join("\n");
  const breaches = auditEvents(events, { runDir: run.work });
  const refusals = read("guard.log").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const limit = !report && (run.forceExhausted || exhausted(errorText));
  const result = { state: report && !breaches.length ? "done" : "failed", provider: run.provider, model: run.model, kind: run.kind, startedAt: run.startedAt, endedAt: (exit && exit.at) || iso(now),
    exhausted: !!limit, trouble: report ? "" : codexTrouble(errorText), breaches, refusals };
  if (report && !breaches.length) result.report = report;
  else if (breaches.length) result.reason = `audit: ${[...new Set(breaches.map(b => b.why))].join("; ")}`;
  else if (!exit) result.reason = "no report: the helper ended without finishing (killed, timed out or crashed)";
  else result.reason = `no report: ${limit ? "the AI reported its limit" : `the AI ended (exit ${exit.code}) without a valid report`}`;
  if (limit) result.marked = markExhausted(env, { name: run.provider, model: run.model }, errorText || "forced", now);
  // cleanup: the run's login first, then its folder (only while the folder is still this helper's:
  // a slot whose helper ended is handed to the next one), then the key file
  const clean = deps.cleanup || ((p, guarded) => (guarded ? cleanupGuardedRun(p, null) : fs.rmSync(p.work, { recursive: true, force: true })));
  try { if (slotOwner(run.work) === unit) clean(guardedPaths(run.work), run.guarded); } catch {}
  try { fs.rmSync(secretFile(env, unit), { force: true }); } catch {}
  writeJson(path.join(dir, "result.json"), result);
  return result;
}

// The builder token lasts an hour and a product helper up to 90 minutes: every round renews the login
// of each running guarded helper whose login is older than 20 minutes. -> units renewed
export function refreshTokens(env, deps = {}) {
  const renewed = [];
  let units = [];
  try { units = fs.readdirSync(path.join(env.STATE_DIR, "helpers")); } catch { return renewed; }
  for (const unit of units) {
    const run = readJson(path.join(helperDir(env, unit), "run.json"), null);
    if (!run || !run.guarded || fs.existsSync(path.join(helperDir(env, unit), "result.json")) || !unitActive(env, unit, deps)) continue;
    const p = guardedPaths(run.work);
    let age = Infinity; try { age = (deps.now ? deps.now() : Date.now()) - fs.statSync(path.posix.join(p.ghDir, "hosts.yml")).mtimeMs; } catch {}
    if (age < 20 * MIN) continue;
    try { (deps.renew || ((e, d) => writeLogin(e, d, mintToken(e))))(env, p.ghDir); renewed.push(unit); } catch { /* the next round tries again */ }
  }
  return renewed;
}

// ---------------------------------------------------------------- the runner (inside the unit)
// Runs the AI CLI with the prompt on stdin; its answer's last JSON object becomes report.json.
export async function runHelper(dir, deps = {}) {
  const env = deps.env || aiDefaults();
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const write = (f, text) => { const tmp = path.join(dir, `.${f}.tmp`); fs.writeFileSync(tmp, text); fs.renameSync(tmp, path.join(dir, f)); };
  const finish = (code, extra = {}) => { write("exit.json", JSON.stringify({ code, at: iso(Date.now()), ...extra }) + "\n"); return code; };
  if (run.forceExhausted) { fs.writeFileSync(path.join(dir, "stderr.txt"), "You've hit your usage limit (forced by FD_FORCE_EXHAUSTED for the drill).\n"); return finish(1, { forced: true }); }
  const argv = run.command || commandFor(env, run, dir);
  const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
  const out = fs.openSync(path.join(dir, "events.jsonl"), "w"), err = fs.openSync(path.join(dir, "stderr.txt"), "w");
  const code = await new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd: run.cwd, stdio: ["pipe", out, err], env: deps.childEnv || process.env });
    child.on("exit", (c, s) => resolve(c === null ? `signal ${s}` : c));
    child.on("error", e => resolve(`spawn failed: ${e.message}`));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
  fs.closeSync(out); fs.closeSync(err);
  let final = "";
  if (run.provider === "claude") final = claudeEvents(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")).final;
  else { try { final = fs.readFileSync(path.join(dir, "last.txt"), "utf8"); } catch {} }
  const report = lastJsonObject(final);
  if (report) write("report.json", JSON.stringify(report, null, 2) + "\n");
  return finish(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "run") {
  runHelper(process.argv[3]).then(code => process.exit(typeof code === "number" ? code : 1), e => { console.error(e.stack || e.message); process.exit(1); });
}
