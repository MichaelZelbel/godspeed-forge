// The trust step: neutralise decision-style comments (an "Owner decision", a contract, a review verdict)
// that come from accounts that may not decide, before the factory's loop reads them (D-419). It used to
// run as its own timer every two minutes (`release-driver.mjs --trust-only`); now it is a step of the
// driver. The runner starts it every two minutes at most as often as the round allows (the round is
// five minutes), so one run repeats the pass every two minutes until nine minutes have passed, and the
// two-minute cadence survives without a timer of its own. The pass itself is release-driver.mjs's
// trustPass (trustLook in release-driver-owner-steps.mjs), unchanged; this file only builds its
// configuration from the settings, one pass for every project the driver looks after.
//
// Who may decide, per project: the owner (settings owner.github_login) and the project's own two Apps
// (project apps.builder, apps.release). release-driver-owner-steps.mjs keeps that list in an exported
// array, TRUSTED; this step sets it for each project before the pass.
import fs from "node:fs";
import path from "node:path";
import { defaults, trustPass } from "../release-driver/release-driver.mjs";
import { TRUSTED } from "../release-driver/release-driver-owner-steps.mjs";

export const STEP = { name: "trust", everyMinutes: 2, maxMinutes: 9, inRound: false };
export const SETTINGS = [
  { key: "owner.github_login", required: true, meaning: "the GitHub account whose decisions count; every other account's decision-style comment is neutralised" },
  { key: "server.factory_user", required: true, meaning: "the account whose GitHub login (the builder App) the pass reads and writes with" },
  { key: "keys.token_script", required: true, meaning: "the script that mints the App's token" },
  { key: "keys.env_file", required: false, default: "the file keys.env in the settings folder", meaning: "the file holding the App's keys" },
  { key: "steps.trust.state_dir", required: false, default: "<server.state_dir>/steps/trust", meaning: "where the pass keeps its cursor (trust.json) and its log; the first project keeps it here, every other project has a folder of its own below it" },
];

const get = (o, dotted) => dotted.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const slug = repo => String(repo).toLowerCase().replace("/", "--");
// "some-builder" or "some-builder[bot]" or {login|slug|name} -> the login REST gives
const appLogin = a => {
  const raw = typeof a === "string" ? a : a && (a.login || a.slug || a.name);
  if (!raw) return null;
  return String(raw).endsWith("[bot]") ? String(raw) : `${raw}[bot]`;
};
export const trustedFor = (settings, project) => [...new Set([get(settings, "owner.github_login"), appLogin(get(project, "apps.builder")), appLogin(get(project, "apps.release"))].filter(Boolean))];

// The old configuration of release-driver.mjs for one project, built from the settings (nothing from
// the process environment, and no default naming anyone).
export function envFor(ctx, project, first) {
  const s = ctx.settings;
  const base = get(s, "steps.trust.state_dir") || path.posix.join(get(s, "server.state_dir") || "", "steps", "trust");
  const rd = {
    RD_REPO: project.repository,
    RD_STATE_DIR: first ? base : path.posix.join(base, slug(project.repository)),
    FORGE_USER: get(s, "server.factory_user"),
    RD_TOKEN_SCRIPT: get(s, "keys.token_script"),
    RD_KEYS_FILE: get(s, "keys.env_file"),
    FORGE_NETNS: get(s, "server.netns"),
    OWNER_LOGIN: get(s, "owner.github_login"),
  };
  const env = defaults(["--trust-only"], { ...(ctx.env || {}), ...Object.fromEntries(Object.entries(rd).filter(([, v]) => v !== undefined && v !== null && v !== "")) });
  env.OWNER_LOGIN = rd.OWNER_LOGIN;
  env.DRY = !!ctx.dry;
  return env;
}

const realSleep = ms => new Promise(r => setTimeout(r, ms));
const realNow = () => Date.now();

// -> { ok, summary, error? }. ctx.sleep / ctx.nowMs / ctx.deps (a stand-in for GitHub) are for tests.
export async function run(ctx) {
  const projects = (ctx.projects && ctx.projects.length ? ctx.projects : [ctx.main]).filter(Boolean);
  if (!projects.length) return { ok: false, summary: "no project to look after", error: "no project" };
  const nowMs = ctx.nowMs || realNow, sleep = ctx.sleep || realSleep, log = ctx.log || (() => {});
  const every = (ctx.everyMinutes || STEP.everyMinutes) * 60000, max = (ctx.maxMinutes || STEP.maxMinutes) * 60000;
  const started = nowMs();
  const before = [...TRUSTED]; // release-driver-owner-steps.mjs keeps who may decide in this exported list
  let passes = 0, handled = 0;
  const failures = [];
  for (;;) {
    for (const [i, project] of projects.entries()) {
      const env = envFor(ctx, project, i === 0);
      TRUSTED.splice(0, TRUSTED.length, ...trustedFor(ctx.settings, project));
      // the log the old timer wrote: decisions.jsonl in the pass's own folder
      const record = e => { fs.mkdirSync(env.STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); };
      try {
        const r = trustPass(env, ctx.deps || {}, nowMs(), record);
        handled += r.handled || 0;
        if (r.busy) log(`trust pass on ${project.repository}: one is going already`);
      } catch (e) { try { record({ kind: "trust look failed", why: String(e.message).slice(0, 200) }); } catch {} failures.push(`${project.repository}: ${String(e.message).slice(0, 200)}`); log(`trust pass on ${project.repository} failed: ${e.message}`); }
    }
    passes++;
    const next = every - ((nowMs() - started) % every);
    if (nowMs() - started + next > max) break;
    await sleep(next);
  }
  TRUSTED.splice(0, TRUSTED.length, ...before);
  const summary = `${passes} trust pass${passes === 1 ? "" : "es"} over ${projects.length} project${projects.length === 1 ? "" : "s"}, ${handled} handled${failures.length ? `; failed: ${failures.join("; ")}` : ""}`;
  return failures.length ? { ok: false, summary, error: failures.join("; ") } : { ok: true, summary };
}
